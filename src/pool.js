'use strict';

/**
 * 密钥池 + 限流 + 熔断调度。
 *
 * 每个渠道下可以挂多个 key，调度策略：
 *   1. 先过滤掉「冷却中 / 已失效 / 额度耗尽」的 key；
 *   2. 剩下的按「今日用量最少」排序（天然负载均衡），同分时看健康度评分；
 *   3. 请求结束按结果回写：成功 → 记延迟与用量；429 → 指数退避冷却；401/403 → 失效冷却；5xx → 短冷却。
 *
 * 限流窗口按 key 独立维护：RPM 用 60 秒滑动窗口，RPD 按自然日（本地时区）计数。
 */

const { dayKey, maskKey, clamp } = require('./util');

class KeyPool {
  constructor(settings = {}) {
    this.settings = settings;
    this.tz = settings.tzOffsetMinutes || 480;
    this.byProvider = new Map(); // providerId -> KeyState[]
    this.rrCursor = new Map(); // providerId -> number
  }

  sync(providers) {
    const next = new Map();
    for (const provider of providers) {
      if (!provider.enabled) continue;
      const prev = this.byProvider.get(provider.id) || [];
      const prevByKey = new Map(prev.map((k) => [k.key, k]));
      const list = [];
      const keys = provider.keyless ? ['__keyless__'] : provider.keys || [];
      for (const key of keys) {
        const existing = prevByKey.get(key);
        if (existing) {
          existing.providerName = provider.name;
          existing.keyless = !!provider.keyless;
          existing.rpm = Number(provider.rpm) || 0;
          existing.rpd = Number(provider.rpd) || 0;
          list.push(existing);
        } else {
          list.push({
            id: `${provider.id}:${maskKey(key)}`,
            providerId: provider.id,
            providerName: provider.name,
            key,
            mask: provider.keyless ? '(无需密钥)' : maskKey(key),
            keyless: !!provider.keyless,
            rpm: Number(provider.rpm) || 0,
            rpd: Number(provider.rpd) || 0,
            status: 'ok',
            reason: '',
            cooldownUntil: 0,
            invalidUntil: 0,
            consecutiveFails: 0,
            inflight: 0,
            ok: 0,
            fail: 0,
            latencySum: 0,
            latencyCount: 0,
            lastUsedAt: 0,
            window: [],
            day: { key: '', count: 0, input: 0, output: 0 },
            addedAt: new Date().toISOString(),
          });
        }
      }
      next.set(provider.id, list);
    }
    this.byProvider = next;
  }

  keysOf(providerId) {
    return this.byProvider.get(providerId) || [];
  }

  refreshDay(state) {
    const today = dayKey(new Date(), this.tz);
    if (state.day.key !== today) {
      state.day = { key: today, count: 0, input: 0, output: 0 };
    }
  }

  /** 当前是否被限流（RPM/RPD） */
  isRateLimited(state) {
    this.refreshDay(state);
    const now = Date.now();
    state.window = state.window.filter((t) => now - t < 60000);
    if (state.rpm > 0 && state.window.length >= state.rpm) {
      const wait = 60000 - (now - state.window[0]);
      return { limited: true, waitMs: Math.max(1000, wait), why: `RPM ${state.rpm} 已达上限` };
    }
    if (state.rpd > 0 && state.day.count >= state.rpd) {
      const tomorrow = new Date();
      tomorrow.setHours(24, 0, 5, 0);
      return { limited: true, waitMs: Math.max(60000, tomorrow.getTime() - now), why: `当日额度 ${state.rpd} 次已用尽` };
    }
    return { limited: false };
  }

  scoreOf(state) {
    const total = state.ok + state.fail;
    const rate = total ? state.ok / total : 0.9;
    const avgLatency = state.latencyCount ? state.latencySum / state.latencyCount : 1500;
    const latencyPenalty = clamp(avgLatency / 100, 0, 40);
    return clamp(rate * 110 - latencyPenalty, 1, 100);
  }

  stateOf(state) {
    if (state.invalidUntil && state.invalidUntil > Date.now()) return 'invalid';
    if (state.cooldownUntil && state.cooldownUntil > Date.now()) return 'cooldown';
    const rl = this.isRateLimited(state);
    if (rl.limited) return 'limited';
    return 'ok';
  }

  available(providerId) {
    const out = [];
    for (const state of this.keysOf(providerId)) {
      if (this.stateOf(state) === 'ok') out.push(state);
    }
    return out;
  }

  /**
   * 取一个可用 key 并「预占」一次额度（写入限流窗口 + 并发计数）。
   * @returns {object|null} KeyState
   */
  acquire(providerId, limit) {
    if (limit == null) limit = this.settings.concurrencyPerKey || 0;
    const underLimit = (k) => !limit || (k.inflight || 0) < limit;

    let list = this.available(providerId).filter(underLimit);
    if (!list.length) {
      // 全部冷却/限流，或都打满并发：挑一个最早恢复的做兜底（等待时间可控时）
      const all = this.keysOf(providerId).filter(underLimit);
      if (!all.length) return null; // 要么没配 key，要么全部并发打满/冷彻底
      const now = Date.now();
      list = all.slice().sort((a, b) => {
        const ra = Math.max(a.cooldownUntil || 0, a.invalidUntil || 0) - now;
        const rb = Math.max(b.cooldownUntil || 0, b.invalidUntil || 0) - now;
        return ra - rb;
      });
      const soonest = list[0];
      const wait = Math.max(soonest.cooldownUntil || 0, soonest.invalidUntil || 0) - now;
      if (wait > 1500) return null; // 等不及，交给别的渠道
    }

    list.sort((a, b) => {
      this.refreshDay(a);
      this.refreshDay(b);
      if (a.day.count !== b.day.count) return a.day.count - b.day.count;
      return this.scoreOf(b) - this.scoreOf(a);
    });

    const cursor = this.rrCursor.get(providerId) || 0;
    const pick = list[cursor % list.length];
    this.rrCursor.set(providerId, cursor + 1);

    this.refreshDay(pick);
    pick.window.push(Date.now());
    pick.day.count += 1;
    pick.inflight = (pick.inflight || 0) + 1;
    pick.lastUsedAt = Date.now();
    return pick;
  }

  /** 请求结束（无论成败）释放一次并发占用 */
  release(state) {
    if (!state) return;
    state.inflight = Math.max(0, (state.inflight || 0) - 1);
  }

  noteUsage(state, input, output) {
    if (!state) return;
    this.refreshDay(state);
    state.day.input += input || 0;
    state.day.output += output || 0;
  }

  /**
   * 回写一次调用结果，处理冷却与熔断。
   * @param {object} state
   * @param {object} res  { ok, kind, status, error, retryAfterMs, latencyMs }
   */
  report(state, res = {}) {
    if (!state) return;
    const now = Date.now();
    const base = this.settings.cooldownBaseMs || 20000;
    const max = this.settings.cooldownMaxMs || 600000;

    if (res.latencyMs) {
      state.latencySum += res.latencyMs;
      state.latencyCount += 1;
    }

    if (res.ok) {
      state.ok += 1;
      state.consecutiveFails = 0;
      state.status = 'ok';
      state.reason = '';
      state.cooldownUntil = 0;
      if (state.invalidUntil && now > state.invalidUntil) state.invalidUntil = 0;
      return;
    }

    state.fail += 1;
    state.consecutiveFails += 1;
    const kind = res.kind || 'server';

    if (kind === 'auth') {
      state.status = 'invalid';
      state.reason = '密钥无效或被拒绝 (401/403)，请检查该渠道密钥';
      state.invalidUntil = now + (this.settings.invalidKeyCooldownMs || 1800000);
      return;
    }
    if (kind === 'request' || kind === 'nomodel') {
      // 不是密钥的错，不计入熔断
      state.consecutiveFails = Math.max(0, state.consecutiveFails - 1);
      state.status = 'ok';
      state.reason = res.error || '';
      return;
    }

    let wait = res.retryAfterMs || 0;
    if (!wait) {
      if (kind === 'quota') {
        const tomorrow = new Date();
        tomorrow.setHours(24, 0, 30, 0);
        wait = tomorrow.getTime() - now;
      } else if (kind === 'ratelimit') {
        wait = Math.min(max, base * Math.pow(2, Math.min(state.consecutiveFails, 5)));
      } else {
        wait = Math.min(max, Math.round(base * 0.75 * Math.pow(1.6, Math.min(state.consecutiveFails, 5))));
      }
    }

    state.status = 'cooldown';
    state.reason = `${kind}: ${String(res.error || '').slice(0, 160)}`;
    state.cooldownUntil = now + clamp(wait, 1000, max);
  }

  /** 渠道级健康度汇总（给 Dashboard 与路由评分用） */
  providerStatus(providerId) {
    const keys = this.keysOf(providerId);
    const agg = { total: keys.length, ok: 0, cooldown: 0, limited: 0, invalid: 0, score: 0, avgLatencyMs: 0, usageToday: 0 };
    let latencyCount = 0;
    let latencySum = 0;
    for (const state of keys) {
      const s = this.stateOf(state);
      if (s === 'ok') agg.ok += 1;
      else if (s === 'cooldown') agg.cooldown += 1;
      else if (s === 'limited') agg.limited += 1;
      else agg.invalid += 1;
      agg.score += this.scoreOf(state);
      latencySum += state.latencySum;
      latencyCount += state.latencyCount;
      this.refreshDay(state);
      agg.usageToday += state.day.count;
    }
    agg.score = keys.length ? agg.score / keys.length : 0;
    agg.avgLatencyMs = latencyCount ? Math.round(latencySum / latencyCount) : 0;
    return agg;
  }

  /** 给管理接口用的明细 */
  describe() {
    const out = {};
    for (const [providerId, keys] of this.byProvider.entries()) {
      out[providerId] = keys.map((state) => {
        const s = this.stateOf(state);
        const now = Date.now();
        return {
          id: state.id,
          mask: state.mask,
          keyless: state.keyless,
          status: s,
          reason: state.reason,
          cooldownMsLeft: Math.max(0, (state.cooldownUntil || 0) - now),
          invalidMsLeft: Math.max(0, (state.invalidUntil || 0) - now),
          ok: state.ok,
          fail: state.fail,
          score: Math.round(this.scoreOf(state) * 10) / 10,
          avgLatencyMs: state.latencyCount ? Math.round(state.latencySum / state.latencyCount) : 0,
          usageToday: state.day.count,
          rpm: state.rpm,
          rpd: state.rpd,
          lastUsedAt: state.lastUsedAt ? new Date(state.lastUsedAt).toISOString() : '',
        };
      });
    }
    return out;
  }

  /** 路由评分：渠道优先级 + 健康度 + 延迟 */
  targetScore(providerId, priority) {
    const st = this.providerStatus(providerId);
    // 尚未使用过的密钥视为健康（stateOf 返回 ok），避免新渠道被冷启动惩罚
    const health = st.total ? (st.ok + st.limited) / st.total : 0;
    const latencyPenalty = st.avgLatencyMs ? clamp(st.avgLatencyMs / 120, 0, 25) : 0;
    return (Number(priority) || 5) * 10 * (0.4 + 0.6 * health) - latencyPenalty + st.score * 0.15;
  }
}

module.exports = { KeyPool };
