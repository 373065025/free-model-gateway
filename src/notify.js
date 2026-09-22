'use strict';

/**
 * 每日用量推送通知
 *
 * 目标：每天在指定时间，把网关的整体用量与运行状况汇总成一条消息，
 * 通过 PushPlus（www.pushplus.plus）推送到微信 / 其他渠道。
 *
 * 设计要点：
 *   - 零依赖：只用 node:fs / node:path 与全局 fetch；
 *   - 纯本地配置：token 存在 CONFIG_DIR/notify-config.json，不上报、不代持；
 *   - 幂等：同一天最多推一次（按配置时区的自然日判断），重启也不会重复推；
 *   - 不泄露：日志与接口回显里 token 一律打码，只回「是否已配置」。
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('./config');
const { dayKey, fmtInt, fmtCn, logger } = require('./util');

const DEFAULT_ENDPOINT = 'https://www.pushplus.plus/send';
const CONFIG_FILE = path.join(CONFIG_DIR, 'notify-config.json');
const CHECK_INTERVAL_MS = 60 * 1000;

const DEFAULTS = {
  enabled: false,
  token: '',
  topic: '',
  channel: 'wechat',
  template: 'html',
  timeOfDay: '09:00',
  endpoint: DEFAULT_ENDPOINT,
  skipIdle: false,
};

let ctxRef = null;
let timer = null;
let lastResult = null;

// ============================================================ 配置读写

function readRaw() {
  try {
    const d = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return d && typeof d === 'object' ? d : {};
  } catch (_e) {
    return {};
  }
}

function writeRaw(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

function mask(token) {
  const t = String(token || '');
  if (t.length <= 8) return t ? '****' : '';
  return `${t.slice(0, 4)}****${t.slice(-4)}`;
}

/** 生效配置（含默认值） */
function effective() {
  const raw = readRaw();
  const cfg = Object.assign({}, DEFAULTS, raw);
  // 归一化时间与端点
  cfg.timeOfDay = /^\d{2}:\d{2}$/.test(String(cfg.timeOfDay)) ? String(cfg.timeOfDay) : DEFAULTS.timeOfDay;
  cfg.endpoint = String(cfg.endpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  cfg.token = String(cfg.token || '').trim();
  return cfg;
}

/** 供接口返回（不外发明文 token） */
function getConfig() {
  const c = effective();
  const raw = readRaw();
  return {
    enabled: !!c.enabled,
    hasToken: !!c.token,
    tokenMask: mask(c.token),
    topic: c.topic || '',
    channel: c.channel || DEFAULTS.channel,
    template: c.template || DEFAULTS.template,
    timeOfDay: c.timeOfDay,
    endpoint: c.endpoint,
    isDefaultEndpoint: c.endpoint === DEFAULT_ENDPOINT,
    skipIdle: !!c.skipIdle,
    lastSentDate: raw.lastSentDate || '',
    today: todayKey(),
    lastResult: raw.lastResult || lastResult || null,
  };
}

/** 保存配置：只接受白名单字段；token 传空字符串表示「清除」 */
function saveConfig(patch) {
  const cur = readRaw();
  const next = Object.assign({}, cur);
  const p = patch || {};

  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  if (typeof p.topic === 'string') next.topic = p.topic.trim();
  if (typeof p.channel === 'string' && p.channel.trim()) next.channel = p.channel.trim();
  if (typeof p.template === 'string' && p.template.trim()) next.template = p.template.trim();
  if (typeof p.timeOfDay === 'string') {
    if (!/^\d{2}:\d{2}$/.test(p.timeOfDay.trim())) return { error: '推送时间格式应为 HH:MM' };
    const [h, m] = p.timeOfDay.trim().split(':').map(Number);
    if (h > 23 || m > 59) return { error: '推送时间超出范围（00:00 ~ 23:59）' };
    next.timeOfDay = p.timeOfDay.trim();
  }
  if (typeof p.endpoint === 'string') next.endpoint = p.endpoint.trim() || DEFAULT_ENDPOINT;
  if (typeof p.skipIdle === 'boolean') next.skipIdle = p.skipIdle;
  // token：undefined 保持原样；非空则替换；显式空串则清除
  if (typeof p.token === 'string') {
    const t = p.token.trim();
    if (t === '') delete next.token;
    else next.token = t;
  }

  writeRaw(next);
  return { ok: true, config: getConfig() };
}

/** 校验 PushPlus token 形态（32 位十六进制），只做友好提示，不做硬拦截 */
function looksLikePushplusToken(t) {
  return /^[a-zA-Z0-9]{16,64}$/.test(String(t || '').trim());
}

// ============================================================ 时间工具

function tzMinutes() {
  const tz = ctxRef && ctxRef.stats && Number.isFinite(ctxRef.stats.tz) ? ctxRef.stats.tz : 480;
  return tz;
}

function todayKey() {
  return dayKey(new Date(), tzMinutes());
}

/** 配置时区下的 HH:MM */
function localHhMm() {
  const shifted = new Date(Date.now() + tzMinutes() * 60000);
  return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
}

function localDateLabel() {
  const shifted = new Date(Date.now() + tzMinutes() * 60000);
  return `${shifted.getUTCMonth() + 1} 月 ${shifted.getUTCDate()} 日`;
}

// ============================================================ 汇总数据

/** 汇总一份日报数据（不包含任何密钥 / 提示词 / 模型输出） */
function buildSummary() {
  const stats = ctxRef && ctxRef.stats;
  const pool = ctxRef && ctxRef.pool;
  const providers = (ctxRef && ctxRef.cfg && ctxRef.cfg.providers) || [];
  const version = (ctxRef && ctxRef.cfg && ctxRef.cfg.version) || '';

  const snap = stats ? stats.snapshot() : null;
  if (!snap) {
    return {
      version,
      day: todayKey(),
      label: localDateLabel(),
      empty: true,
      calls: 0, success: 0, failed: 0, successRate: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0,
      todayCalls: 0, todayTotal: 0,
      avgLatencyMs: 0, retries: 0,
      uptimeDays: 0, activeDays: 0,
      peak: null,
      top: [],
      providerHealthy: 0, providerTotal: 0, keysHealthy: 0, keysTotal: 0,
      errors: 0,
    };
  }

  const t = snap.totals;
  const top = (snap.leaderboard || []).slice(0, 6).map((r) => ({
    name: r.name,
    calls: r.calls,
    total: r.total,
    share: r.share,
  }));

  let providerHealthy = 0;
  let providerTotal = 0;
  let keysHealthy = 0;
  let keysTotal = 0;
  const failing = [];
  for (const p of providers) {
    if (p.type === 'mock' || p.id === 'mock') continue;
    if (!p.enabled) continue;
    providerTotal += 1;
    const h = pool ? pool.providerStatus(p.id) : { ok: 0, total: 0 };
    keysTotal += h.total || 0;
    keysHealthy += h.ok || 0;
    if (h.total > 0 && h.ok > 0) providerHealthy += 1;
    else if (h.total > 0) failing.push(p.name);
  }

  return {
    version,
    day: snap.meta.today || todayKey(),
    label: localDateLabel(),
    empty: false,
    calls: t.calls,
    success: t.success,
    failed: t.failed,
    successRate: t.successRate,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    totalTokens: t.totalTokens,
    todayCalls: snap.today.calls,
    todayTotal: snap.today.total,
    avgLatencyMs: t.avgLatencyMs,
    retries: t.retries,
    uptimeDays: snap.meta.uptimeDays,
    activeDays: snap.meta.activeDays,
    peak: snap.peakDay || null,
    top,
    providerHealthy,
    providerTotal,
    keysHealthy,
    keysTotal,
    errors: t.failed,
  };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 生成推送标题 */
function buildTitle(s) {
  return `聚合网关日报 · ${s.label}`;
}

/** 生成 HTML 正文（PushPlus 微信公众号渠道对 html 模板支持最好） */
function buildHtml(s) {
  const pct = (x) => `${(Number(x || 0) * 100).toFixed(1)}%`;
  const rows = s.top.length
    ? s.top.map((r, i) => `<tr>
        <td style="padding:4px 8px;color:#8a8f98">${i + 1}</td>
        <td style="padding:4px 8px">${esc(r.name)}</td>
        <td style="padding:4px 8px;text-align:right">${fmtCn(r.total)}</td>
        <td style="padding:4px 8px;text-align:right;color:#8a8f98">${fmtInt(r.calls)} 次</td>
      </tr>`).join('')
    : '<tr><td colspan="4" style="padding:6px 8px;color:#8a8f98">暂无调用记录</td></tr>';

  const peak = s.peak
    ? `${esc(s.peak.day)} · ${fmtCn(s.peak.total)} tokens（${fmtInt(s.peak.calls)} 次）`
    : '暂无';

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;font-size:14px;color:#1d1d1f;line-height:1.7">',
    `<div style="font-size:16px;font-weight:600;margin-bottom:10px">📊 ${esc(s.label)} · 用量日报</div>`,
    s.empty
      ? '<div style="color:#8a8f98">本机暂无统计数据（网关可能刚启动或从未收到请求）。</div>'
      : [
        '<table style="border-collapse:collapse;width:100%;margin-bottom:10px">',
        `<tr><td style="padding:3px 8px;color:#8a8f98">今日调用</td><td style="padding:3px 8px;text-align:right"><b>${fmtInt(s.todayCalls)}</b> 次 · ${fmtCn(s.todayTotal)} tokens</td></tr>`,
        `<tr><td style="padding:3px 8px;color:#8a8f98">累计调用</td><td style="padding:3px 8px;text-align:right"><b>${fmtInt(s.calls)}</b> 次（成功 ${fmtInt(s.success)} / 失败 ${fmtInt(s.failed)}）</td></tr>`,
        `<tr><td style="padding:3px 8px;color:#8a8f98">成功率</td><td style="padding:3px 8px;text-align:right">${pct(s.successRate)} · 平均延迟 ${fmtInt(s.avgLatencyMs)} ms</td></tr>`,
        `<tr><td style="padding:3px 8px;color:#8a8f98">Tokens</td><td style="padding:3px 8px;text-align:right">输入 ${fmtCn(s.inputTokens)} · 输出 ${fmtCn(s.outputTokens)}</td></tr>`,
        `<tr><td style="padding:3px 8px;color:#8a8f98">连续服务</td><td style="padding:3px 8px;text-align:right">${fmtInt(s.uptimeDays)} 天（活跃 ${fmtInt(s.activeDays)} 天）</td></tr>`,
        `<tr><td style="padding:3px 8px;color:#8a8f98">渠道健康</td><td style="padding:3px 8px;text-align:right">${s.providerHealthy}/${s.providerTotal} 渠道 · ${s.keysHealthy}/${s.keysTotal} 密钥可用</td></tr>`,
        '</table>',
        '<div style="font-weight:600;margin:10px 0 4px">消耗最多的模型</div>',
        `<table style="border-collapse:collapse;width:100%">${rows}</table>`,
        `<div style="margin-top:8px;color:#8a8f98;font-size:12px">峰值日：${peak}</div>`,
      ].join(''),
    `<div style="margin-top:12px;padding-top:8px;border-top:1px solid #e5e5ea;color:#8a8f98;font-size:12px">免费模型聚合网关 v${esc(s.version)} · 数据仅在本机统计</div>`,
    '</div>',
  ].join('');
}

// ============================================================ 发送

/**
 * 调用 PushPlus 发送。
 * 文档：POST /send，JSON body；code === 200 表示服务端已接收（异步投递，不代表最终送达）。
 */
async function push({ title, content, template, channel, topic, token, endpoint }) {
  const body = {
    token: token,
    title: title,
    content: content,
    template: template || 'html',
    channel: channel || 'wechat',
  };
  if (topic) body.topic = topic;

  const ctrl = new AbortController();
  const timerId = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(endpoint || DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_e) { json = null; }
    if (!resp.ok) {
      return { ok: false, code: resp.status, msg: `HTTP ${resp.status}`, raw: String(text).slice(0, 300) };
    }
    if (!json) return { ok: false, code: 0, msg: '推送服务返回了非 JSON 内容', raw: String(text).slice(0, 300) };
    return {
      ok: Number(json.code) === 200,
      code: json.code,
      msg: String(json.msg || ''),
      id: json.data || '',
    };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? '推送请求超时（15s）' : (err && err.message) || String(err);
    return { ok: false, code: 0, msg };
  } finally {
    clearTimeout(timerId);
  }
}

/**
 * 立即推送日报。
 * @param {object} opts { force?: boolean, reason?: 'manual'|'test'|'schedule' }
 */
async function sendDaily(opts = {}) {
  const c = effective();
  if (!c.token) return { ok: false, error: '尚未配置 PushPlus token' };

  const summary = buildSummary();
  if (c.skipIdle && summary.todayCalls === 0 && !opts.force) {
    return { ok: false, skipped: true, error: '今日无调用，已按「无流量不推送」跳过' };
  }

  const res = await push({
    title: buildTitle(summary),
    content: buildHtml(summary),
    template: c.template,
    channel: c.channel,
    topic: c.topic,
    token: c.token,
    endpoint: c.endpoint,
  });

  lastResult = {
    at: Date.now(),
    ok: !!res.ok,
    code: res.code || 0,
    msg: res.msg || res.error || '',
    id: res.id || '',
    reason: opts.reason || 'manual',
    day: summary.day,
  };

  const raw = readRaw();
  raw.lastResult = lastResult;
  // 注意：测试消息不占用「今日已推送」额度，否则发一次测试会把当天的日报顶掉；
  // 手动发送与定时发送则都会记账，避免同一天重复推送。
  if (res.ok && opts.reason !== 'test') raw.lastSentDate = todayKey();
  writeRaw(raw);

  if (res.ok) {
    logger.info(`[notify] 日报已提交推送（${lastResult.reason}）：${summary.day}`);
  } else {
    logger.warn(`[notify] 推送失败（${lastResult.reason}）：${res.msg || '未知错误'}`);
  }
  return { ok: !!res.ok, result: lastResult, summary: publicSummary(summary) };
}

/** 发送一条测试消息（用固定文案，便于确认渠道是否打通） */
async function sendTest() {
  const c = effective();
  if (!c.token) return { ok: false, error: '尚未配置 PushPlus token' };
  const s = buildSummary();
  const res = await push({
    title: '聚合网关 · 推送测试',
    content: [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;line-height:1.7">',
      '<div style="font-size:16px;font-weight:600;margin-bottom:8px">✅ 推送配置成功</div>',
      `<div>当前版本 <b>v${esc(s.version)}</b></div>`,
      `<div>今日调用 <b>${fmtInt(s.todayCalls)}</b> 次 · 累计 <b>${fmtInt(s.calls)}</b> 次</div>`,
      `<div>渠道健康 ${s.providerHealthy}/${s.providerTotal} · 密钥 ${s.keysHealthy}/${s.keysTotal}</div>`,
      '<div style="margin-top:10px;color:#8a8f98;font-size:12px">收到这条消息说明 token 与渠道都配置正确，之后会按设定时间推送每日日报。</div>',
      '</div>',
    ].join(''),
    template: c.template,
    channel: c.channel,
    topic: c.topic,
    token: c.token,
    endpoint: c.endpoint,
  });
  lastResult = { at: Date.now(), ok: !!res.ok, code: res.code || 0, msg: res.msg || '', id: res.id || '', reason: 'test', day: s.day };
  const raw = readRaw();
  raw.lastResult = lastResult;
  writeRaw(raw);
  return { ok: !!res.ok, result: lastResult };
}

/** 去掉内部字段后的摘要，可安全回给前端 */
function publicSummary(s) {
  return {
    day: s.day,
    label: s.label,
    version: s.version,
    todayCalls: s.todayCalls,
    todayTotal: s.todayTotal,
    calls: s.calls,
    success: s.success,
    failed: s.failed,
    totalTokens: s.totalTokens,
    providerHealthy: s.providerHealthy,
    providerTotal: s.providerTotal,
    keysHealthy: s.keysHealthy,
    keysTotal: s.keysTotal,
  };
}

/** 预览当前会推送的内容（不发送） */
function preview() {
  const s = buildSummary();
  const c = effective();
  return {
    title: buildTitle(s),
    html: buildHtml(s),
    summary: publicSummary(s),
    channel: c.channel,
    template: c.template,
    topic: c.topic,
    timeOfDay: c.timeOfDay,
    enabled: !!c.enabled,
  };
}

// ============================================================ 调度

/** 是否已过今天的推送时间点 */
function dueTime(nowHhMm, targetHhMm) {
  return nowHhMm >= targetHhMm;
}

async function tick(reason) {
  const c = effective();
  if (!c.enabled) return;
  const raw = readRaw();
  const today = todayKey();
  if (raw.lastSentDate === today) return;         // 今天已推过
  if (!dueTime(localHhMm(), c.timeOfDay)) return; // 还没到点
  if (!c.token) return;
  await sendDaily({ reason: 'schedule' });
}

/** 启动每日调度（幂等，可重复调用） */
function startScheduler(ctx) {
  if (ctx) ctxRef = ctx;
  if (timer) return timer;
  // 启动后 15 秒先检查一次（补上「到点时应用没开着」的情况）
  setTimeout(() => { tick('boot').catch(() => {}); }, 15000).unref?.();
  timer = setInterval(() => { tick('interval').catch(() => {}); }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 绑定运行上下文（createApp 时调用，供 /preview 与日报汇总取数） */
function setContext(ctx) { ctxRef = ctx; }

/** 供测试注入上下文 */
function _setContext(ctx) { ctxRef = ctx; }

module.exports = {
  DEFAULT_ENDPOINT,
  getConfig,
  saveConfig,
  looksLikePushplusToken,
  buildSummary,
  buildTitle,
  buildHtml,
  push,
  sendDaily,
  sendTest,
  preview,
  startScheduler,
  stopScheduler,
  setContext,
  _setContext,
  _internals: { effective, todayKey, localHhMm, dueTime, mask, CONFIG_FILE, tick },
};
