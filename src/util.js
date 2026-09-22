'use strict';

/**
 * 通用工具函数集合（零依赖，仅使用 Node 内置模块）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF\u3040-\u30FF\uAC00-\uD7AF]/;
const EMojiLike = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_e) {
    return fallback;
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

/** 展开配置里的 ${ENV_VAR} 占位符 */
function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, name) => process.env[name] || '');
}

function nowMs() {
  return Date.now();
}

/** 按指定时区偏移得到 YYYY-MM-DD */
function dayKey(date = new Date(), tzOffsetMinutes = 480) {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** 按指定时区偏移得到 YYYY-MM-DD HH:00 */
function hourKey(date = new Date(), tzOffsetMinutes = 480) {
  const shifted = new Date(date.getTime() + tzOffsetMinutes * 60000);
  return shifted.toISOString().slice(0, 13) + ':00';
}

/** 返回距今 n 天的连续日期数组（含今天），升序 */
function lastNDays(n, tzOffsetMinutes = 480, endDate = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(endDate.getTime() - i * 86400000);
    out.push(dayKey(d, tzOffsetMinutes));
  }
  return out;
}

function diffDays(aKey, bKey) {
  const a = Date.parse(`${aKey}T00:00:00Z`);
  const b = Date.parse(`${bKey}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/**
 * 粗略 token 估算：中日韩字符约 0.9 token/字，其余按 4 字符/token。
 * 仅在渠道未返回 usage 时兜底使用。
 */
function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  let cjk = 0;
  let other = 0;
  EMojiLike.lastIndex = 0;
  for (const ch of s) {
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, Math.ceil(cjk * 0.9 + other / 4));
}

/** 估算整个 messages 数组的输入 token */
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    total += 6; // 每条消息的结构开销
    if (typeof m.content === 'string') total += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part) continue;
        if (part.type === 'text') total += estimateTokens(part.text);
        else if (part.type === 'image_url') total += 260; // 图片按约 260 token 粗估
        else total += 32;
      }
    }
    if (m.name) total += estimateTokens(m.name);
  }
  return total;
}

/** 从响应里抽取输出文本，用于估算 token */
function extractOutputText(json) {
  if (!json || !Array.isArray(json.choices)) return '';
  let out = '';
  for (const c of json.choices) {
    const msg = c && (c.message || c.delta);
    if (!msg) continue;
    if (typeof msg.content === 'string') out += msg.content;
    else if (Array.isArray(msg.content)) {
      for (const p of msg.content) if (p && p.text) out += p.text;
    }
    if (typeof msg.reasoning_content === 'string') out += msg.reasoning_content;
  }
  return out;
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return `${s.slice(0, 3)}***`;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-***')
    .replace(/gsk_[A-Za-z0-9_\-]{12,}/g, 'gsk_***')
    .replace(/AIza[A-Za-z0-9_\-]{10,}/g, 'AIza***')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{12,}/gi, '$1***');
}

function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带抖动的指数退避 */
function backoffMs(base, attempt, max, jitterRatio = 0.25) {
  const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = raw * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(200, Math.round(raw + jitter));
}

function fmtInt(n) {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** 12345678 -> 1234.6万 / 5.57e9 -> 55.77亿 */
function fmtCn(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(Math.round(v));
}

/** 解析 Retry-After 头 */
function parseRetryAfter(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 0;
}

/** 从多家渠道的限流文案里尽力解析出冷却时间 */
function guessCooldownFromText(text) {
  if (!text) return 0;
  const s = String(text);
  let m = s.match(/try again in ([\d.]+)\s*(ms|s|m|h)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
    return Math.round(n * mult);
  }
  m = s.match(/(\d+)\s*(秒|分钟后|分钟)/);
  if (m) return Number(m[1]) * 1000 * (m[2] === '秒' ? 1 : 60);
  return 0;
}

function isAbortError(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || /aborted/i.test(String(err.message || '')));
}

/**
 * 判断一次上游错误属于哪一类，决定要不要换渠道重试。
 * auth    -> 密钥失效（换 key）
 * ratelimit -> 限流（换 key / 冷却）
 * quota   -> 当日额度耗尽（冷却到明天）
 * server  -> 上游故障（短冷却，换渠道）
 * request -> 请求本身有问题（不重试，直接返回给客户端）
 * network -> 网络不可达（换渠道）
 */
function classifyError(status, bodyText) {
  const text = String(bodyText || '').toLowerCase();
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || /insufficient|quota exceeded|out of credits|balance|欠费|余额/.test(text)) return 'quota';
  if (status === 429 || /rate limit|too many requests|rpm|rpd|频率|限流/.test(text)) return 'ratelimit';
  if (status === 404 || /model not found|no such model|does not exist|not supported|unsupported model/.test(text)) return 'nomodel';
  if (status === 400 || status === 422) return 'request';
  if (status >= 500) return 'server';
  if (status === 408 || status === 504) return 'network';
  return 'server';
}

const RETRYABLE = new Set(['auth', 'ratelimit', 'quota', 'server', 'network', 'nomodel']);

function logger(scope) {
  const stamp = () => new Date().toISOString().slice(11, 23);
  const emit = (level, ...args) => {
    const line = `[${stamp()}] ${level} [${scope}] ${args.join(' ')}`;
    if (level === 'ERROR') console.error(line);
    else console.log(line);
  };
  return {
    info: (...a) => emit('INFO ', ...a),
    warn: (...a) => emit('WARN ', ...a),
    error: (...a) => emit('ERROR', ...a),
  };
}

module.exports = {
  ensureDir,
  readJson,
  writeJsonAtomic,
  readText,
  writeText,
  expandEnv,
  nowMs,
  dayKey,
  hourKey,
  lastNDays,
  diffDays,
  estimateTokens,
  estimateMessagesTokens,
  extractOutputText,
  maskKey,
  redactSecrets,
  randomId,
  clamp,
  sleep,
  backoffMs,
  fmtInt,
  fmtCn,
  parseRetryAfter,
  guessCooldownFromText,
  isAbortError,
  classifyError,
  RETRYABLE,
  logger,
};
