'use strict';

/**
 * 用量统计：累计调用、输入/输出 token、按模型/渠道聚合、每日趋势、峰值日。
 * 参考了 One-API 那类网关的观感指标，但完全本地统计、不依赖外部服务。
 */

const {
  readJson,
  writeJsonAtomic,
  dayKey,
  hourKey,
  lastNDays,
  diffDays,
  logger,
} = require('./util');

const log = logger('stats');

class Stats {
  constructor(opts = {}) {
    this.file = opts.file;
    this.tz = opts.tzOffsetMinutes || 480;
    this.logLimit = opts.logLimit || 300;
    this.flushMs = opts.flushMs || 5000;
    this.logs = [];
    this.dirty = false;
    this.timer = null;
    this.data = this.blank();
    this.load();
  }

  blank() {
    return {
      version: 1,
      meta: {
        startedAt: new Date().toISOString(),
        firstDay: dayKey(new Date(), this.tz),
        demo: false,
      },
      totals: {
        calls: 0,
        success: 0,
        failed: 0,
        streamCalls: 0,
        retries: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencySum: 0,
        latencyCount: 0,
      },
      daily: {},
      byModel: {},
      byProvider: {},
      byHour: {},
    };
  }

  load() {
    if (!this.file) return;
    const raw = readJson(this.file, null);
    if (!raw || typeof raw !== 'object') return;
    const fresh = this.blank();
    this.data = {
      version: 1,
      meta: Object.assign(fresh.meta, raw.meta || {}),
      totals: Object.assign(fresh.totals, raw.totals || {}),
      daily: raw.daily || {},
      byModel: raw.byModel || {},
      byProvider: raw.byProvider || {},
      byHour: raw.byHour || {},
    };
    if (!this.data.meta.firstDay) this.data.meta.firstDay = dayKey(new Date(), this.tz);
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      log.error('写入统计文件失败:', err.message);
      this.dirty = true;
    }
  }

  /**
   * 记录一次客户端请求结果（含失败）。
   * @param {object} evt
   * @param {boolean} evt.ok            是否最终成功
   * @param {string}  evt.model         规范模型名
   * @param {string}  evt.providerId    最终服务的渠道（失败时可为空）
   * @param {string}  evt.providerName
   * @param {number}  evt.inputTokens
   * @param {number}  evt.outputTokens
   * @param {number}  evt.latencyMs
   * @param {boolean} evt.stream
   * @param {number}  evt.attempts
   * @param {string}  evt.error
   */
  record(evt) {
    const now = new Date();
    const dk = dayKey(now, this.tz);
    const hk = hourKey(now, this.tz);

    const t = this.data.totals;
    t.calls += 1;
    if (evt.ok) t.success += 1;
    else t.failed += 1;
    if (evt.stream) t.streamCalls += 1;
    t.retries += Math.max(0, (evt.attempts || 1) - 1);
    t.inputTokens += evt.inputTokens || 0;
    t.outputTokens += evt.outputTokens || 0;
    if (evt.latencyMs) {
      t.latencySum += evt.latencyMs;
      t.latencyCount += 1;
    }

    if (!this.data.daily[dk]) this.data.daily[dk] = { calls: 0, input: 0, output: 0 };
    const day = this.data.daily[dk];
    day.calls += 1;
    day.input += evt.inputTokens || 0;
    day.output += evt.outputTokens || 0;

    if (!this.data.byHour[hk]) this.data.byHour[hk] = { calls: 0, input: 0, output: 0 };
    const hour = this.data.byHour[hk];
    hour.calls += 1;
    hour.input += evt.inputTokens || 0;
    hour.output += evt.outputTokens || 0;

    const modelKey = evt.model || 'unknown';
    if (!this.data.byModel[modelKey]) this.data.byModel[modelKey] = { calls: 0, input: 0, output: 0, failed: 0 };
    const bm = this.data.byModel[modelKey];
    bm.calls += 1;
    bm.input += evt.inputTokens || 0;
    bm.output += evt.outputTokens || 0;
    if (!evt.ok) bm.failed += 1;

    if (evt.providerId) {
      if (!this.data.byProvider[evt.providerId]) {
        this.data.byProvider[evt.providerId] = {
          calls: 0, ok: 0, failed: 0, input: 0, output: 0, latencySum: 0, latencyCount: 0,
        };
      }
      const bp = this.data.byProvider[evt.providerId];
      bp.calls += 1;
      if (evt.ok) bp.ok += 1;
      else bp.failed += 1;
      bp.input += evt.inputTokens || 0;
      bp.output += evt.outputTokens || 0;
      if (evt.latencyMs) {
        bp.latencySum += evt.latencyMs;
        bp.latencyCount += 1;
      }
    }

    this.pushLog(evt);
    this.touch();
  }

  pushLog(evt) {
    this.logs.unshift({
      ts: new Date().toISOString(),
      model: evt.model,
      provider: evt.providerName || evt.providerId || '-',
      providerId: evt.providerId || '',
      ok: !!evt.ok,
      stream: !!evt.stream,
      input: evt.inputTokens || 0,
      output: evt.outputTokens || 0,
      latencyMs: evt.latencyMs || 0,
      attempts: evt.attempts || 1,
      route: evt.route || '',
      error: evt.error || '',
      client: evt.client || '',
    });
    if (this.logs.length > this.logLimit) this.logs.length = this.logLimit;
  }

  /** 连续服务天数：从今天（或昨天）往前连续有流量的天数 */
  streakDays() {
    const days = Object.keys(this.data.daily).filter((d) => this.data.daily[d].calls > 0);
    if (!days.length) return 0;
    const set = new Set(days);
    const today = dayKey(new Date(), this.tz);
    let cursor = set.has(today) ? today : dayKey(new Date(Date.now() - 86400000), this.tz);
    if (!set.has(cursor)) return 0;
    let n = 0;
    while (set.has(cursor)) {
      n += 1;
      cursor = dayKey(new Date(Date.parse(`${cursor}T00:00:00Z`) - 86400000), 0);
    }
    return n;
  }

  activeDays() {
    return Object.keys(this.data.daily).filter((d) => this.data.daily[d].calls > 0).length;
  }

  peakDay() {
    let best = null;
    for (const [d, v] of Object.entries(this.data.daily)) {
      const total = v.input + v.output;
      if (!best || total > best.total) best = { day: d, total, calls: v.calls, input: v.input, output: v.output };
    }
    return best;
  }

  trend(days = 29) {
    return lastNDays(days, this.tz).map((d) => {
      const v = this.data.daily[d] || { calls: 0, input: 0, output: 0 };
      return { day: d, calls: v.calls, input: v.input, output: v.output, total: v.input + v.output };
    });
  }

  hourly(hours = 24) {
    const out = [];
    const now = Date.now();
    for (let i = hours - 1; i >= 0; i -= 1) {
      const t = new Date(now - i * 3600000);
      const shifted = new Date(t.getTime() + this.tz * 60000);
      const hk = `${shifted.toISOString().slice(0, 13)}:00`;
      const v = this.data.byHour[hk] || { calls: 0, input: 0, output: 0 };
      out.push({ hour: hk, calls: v.calls, total: v.input + v.output });
    }
    return out;
  }

  leaderboard(limit = 8) {
    const rows = Object.entries(this.data.byModel).map(([name, v]) => ({
      name,
      calls: v.calls,
      input: v.input,
      output: v.output,
      total: v.input + v.output,
      failed: v.failed,
    }));
    rows.sort((a, b) => b.total - a.total || b.calls - a.calls);
    const grand = rows.reduce((s, r) => s + r.total, 0) || 1;
    const top = rows.slice(0, limit).map((r) => Object.assign({}, r, { share: r.total / grand }));
    if (rows.length > limit) {
      const rest = rows.slice(limit);
      const total = rest.reduce((s, r) => s + r.total, 0);
      const calls = rest.reduce((s, r) => s + r.calls, 0);
      const input = rest.reduce((s, r) => s + r.input, 0);
      const output = rest.reduce((s, r) => s + r.output, 0);
      top.push({ name: '其他模型', calls, input, output, total, failed: 0, share: total / grand, aggregated: true });
    }
    return top;
  }

  snapshot() {
    const t = this.data.totals;
    const today = dayKey(new Date(), this.tz);
    const tv = this.data.daily[today] || { calls: 0, input: 0, output: 0 };
    const peak = this.peakDay();
    const streak = this.streakDays();
    const active = this.activeDays();
    return {
      meta: Object.assign({}, this.data.meta, {
        today,
        uptimeDays: streak,
        activeDays: active,
        totalDays: diffDays(this.data.meta.firstDay, today) + 1,
      }),
      totals: {
        calls: t.calls,
        success: t.success,
        failed: t.failed,
        streamCalls: t.streamCalls,
        retries: t.retries,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        totalTokens: t.inputTokens + t.outputTokens,
        avgLatencyMs: t.latencyCount ? Math.round(t.latencySum / t.latencyCount) : 0,
        successRate: t.calls ? t.success / t.calls : 1,
      },
      today: { day: today, calls: tv.calls, input: tv.input, output: tv.output, total: tv.input + tv.output },
      peakDay: peak,
      trend: this.trend(29),
      hourly: this.hourly(24),
      leaderboard: this.leaderboard(8),
      byProvider: this.data.byProvider,
    };
  }

  recentLogs(limit = 60) {
    return this.logs.slice(0, limit);
  }

  reset() {
    this.data = this.blank();
    this.logs = [];
    this.dirty = true;
    this.flush();
  }

  seed(payload) {
    // 供 seed-demo 脚本注入演示数据，仅覆盖统计结构
    const fresh = this.blank();
    this.data = {
      version: 1,
      meta: Object.assign(fresh.meta, payload.meta || {}),
      totals: Object.assign(fresh.totals, payload.totals || {}),
      daily: payload.daily || {},
      byModel: payload.byModel || {},
      byProvider: payload.byProvider || {},
      byHour: payload.byHour || {},
    };
    this.dirty = true;
    this.flush();
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

module.exports = { Stats };
