'use strict';

/**
 * 配置备份与恢复。
 *
 * 备份内容 = 4 份配置文件的原样 JSON：
 *   providers.json（渠道与设置）/ keys.json（各家 API 密钥）
 *   notify-config.json（推送）/ update-config.json（更新源）
 * 绝不包含：用户协议同意状态（换机应重新同意）、gateway-key（每台机器各自生成）、
 * 用量统计（data/）与自动发现结果（models.discovered.json，可随时重新生成）。
 *
 * 加密：给出口令时用 AES-256-GCM 加密整个载荷，密钥由 PBKDF2-SHA256 派生
 * （21 万次迭代 + 随机盐），口令本身不落盘、不进日志、不出现在响应里。
 * 不给口令则明文导出并附 SHA-256 校验和，便于确认文件没被改过。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KIND = 'free-model-gateway-backup';
const APP = 'free-model-gateway';
const KDF = 'PBKDF2-SHA256';
const CIPHER = 'AES-256-GCM';
const ITERATIONS = 210000;

const RESTORE_SCOPE = '恢复时会应用：渠道与模型清单、各渠道 API 密钥、推送配置、更新源设置；'
  + '用户协议同意状态、网关访问密钥（gateway-key）与用量统计保持本机不变。';

const b64 = (buf) => buf.toString('base64');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '';
  } catch (_e) {
    return '';
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return null;
  }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 收集要备份的配置。secrets=false 时不带密钥与推送 token，便于把配置发给别人排查 */
function collect(ctx, { secrets }) {
  const dir = ctx.cfg.paths.configDir;
  const providers = readJsonFile(ctx.cfg.paths.providersFile);
  const keys = secrets ? readJsonFile(ctx.cfg.paths.keysFile) : null;
  const notify = readJsonFile(path.join(dir, 'notify-config.json'));
  const update = readJsonFile(path.join(dir, 'update-config.json'));

  const data = {
    providers: isObj(providers) ? providers : null,
    keys: isObj(keys) ? keys : null,
    notify: isObj(notify) ? notify : null,
    update: isObj(update) ? update : null,
  };
  if (!secrets && data.notify && data.notify.token) {
    data.notify = Object.assign({}, data.notify, { token: '' });
  }
  return data;
}

/** 用口令加密一段文本；口令不落盘、不进日志 */
function encrypt(text, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return {
    kdf: KDF,
    iterations: ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    cipher: CIPHER,
    tag: b64(cipher.getAuthTag()),
    data: b64(enc),
  };
}

/** 解密；口令不对时 GCM 校验会失败并抛错（由调用方转成可读提示） */
function decrypt(env, password) {
  const salt = Buffer.from(String(env.salt || ''), 'base64');
  const iv = Buffer.from(String(env.iv || ''), 'base64');
  const tag = Buffer.from(String(env.tag || ''), 'base64');
  if (!salt.length || !iv.length || !tag.length) {
    throw new Error('备份缺少加密参数，文件可能不完整');
  }
  const key = crypto.pbkdf2Sync(String(password || ''), salt, Number(env.iterations) || ITERATIONS, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(String(env.data || ''), 'base64')), decipher.final()]).toString('utf8');
}

/** 生成备份信封。password 非空则整体加密 */
function build(ctx, { secrets, password }) {
  const includeSecrets = secrets !== false;
  const data = collect(ctx, { secrets: includeSecrets });
  const payloadText = JSON.stringify(data);
  const head = {
    kind: KIND,
    app: APP,
    version: readPackageVersion(),
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    restoreScope: RESTORE_SCOPE,
  };
  if (password) {
    return Object.assign(head, { encrypted: true }, encrypt(payloadText, password));
  }
  return Object.assign(head, {
    encrypted: false,
    checksum: sha256(payloadText),
    data,
  });
}

/**
 * 解析备份文件 → { ok, data?, summary?, error? }
 * 只认自己导出的格式（kind / app 双重校验），加密文件必须给对口令。
 */
function parse(raw, password) {
  if (!isObj(raw)) return { ok: false, error: '备份内容不是有效的 JSON 对象' };
  if (raw.kind !== KIND) return { ok: false, error: '这不是本应用的配置备份（kind 不匹配），已拒绝导入' };
  if (raw.app && raw.app !== APP) return { ok: false, error: `备份来自其它应用（${raw.app}），已拒绝导入` };

  let data;
  if (raw.encrypted) {
    if (!password) return { ok: false, error: '这份备份已加密，请输入导出时设置的口令' };
    try {
      data = JSON.parse(decrypt(raw, password));
    } catch (_e) {
      return { ok: false, error: '解密失败：口令不对，或备份文件已损坏' };
    }
  } else {
    data = raw.data;
    if (raw.checksum && isObj(data)) {
      if (sha256(JSON.stringify(data)) !== raw.checksum) {
        return { ok: false, error: '校验和不匹配，备份文件可能被修改过' };
      }
    }
  }
  if (!isObj(data)) return { ok: false, error: '备份内容缺失，文件可能不完整' };
  if (!isObj(data.providers) || !Array.isArray(data.providers.providers)) {
    return { ok: false, error: '备份里没有渠道信息（providers），可能不是本应用导出的备份' };
  }
  return { ok: true, data, summary: summarize(data) };
}

/** 恢复前给用户看的摘要：要恢复什么、各多少条 */
function summarize(data) {
  const providers = isObj(data.providers) ? data.providers : {};
  const keys = isObj(data.keys) ? data.keys : {};
  const keyCount = Object.keys(keys).reduce((s, k) => s + (Array.isArray(keys[k]) ? keys[k].length : 0), 0);
  const channels = Array.isArray(providers.providers) ? providers.providers : [];
  return {
    channels: channels.length,
    enabledChannels: channels.filter((p) => p && p.enabled !== false).length,
    keys: keyCount,
    hasProvidersSettings: isObj(providers.settings),
    notify: isObj(data.notify) ? (data.notify.token ? '含推送 token' : '已配置（不含 token）') : '无',
    update: isObj(data.update) ? '已配置' : '无',
  };
}

/**
 * 把备份写回本机配置文件。只动上面列的四份文件，其余一概不碰。
 * 返回写入了哪些文件；调用方随后应 reload() 让配置生效。
 */
function apply(ctx, data) {
  const dir = ctx.cfg.paths.configDir;
  const written = [];

  if (isObj(data.providers)) {
    fs.writeFileSync(ctx.cfg.paths.providersFile, JSON.stringify(data.providers, null, 2), 'utf8');
    written.push('providers.json');
  }
  if (isObj(data.keys)) {
    fs.writeFileSync(ctx.cfg.paths.keysFile, JSON.stringify(data.keys, null, 2), 'utf8');
    written.push('keys.json');
  }
  if (isObj(data.notify)) {
    fs.writeFileSync(path.join(dir, 'notify-config.json'), JSON.stringify(data.notify, null, 2), 'utf8');
    written.push('notify-config.json');
  }
  if (isObj(data.update)) {
    fs.writeFileSync(path.join(dir, 'update-config.json'), JSON.stringify(data.update, null, 2), 'utf8');
    written.push('update-config.json');
  }
  return { files: written };
}

module.exports = {
  KIND,
  APP,
  RESTORE_SCOPE,
  build,
  parse,
  summarize,
  apply,
  // 仅供测试
  _internals: { encrypt, decrypt, collect, sha256 },
};
