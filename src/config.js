'use strict';

/**
 * 配置加载 + 模型注册表构建。
 *
 * 关键概念：
 *  - provider（渠道）：一家免费平台，例如 Groq / Gemini / 智谱。
 *  - key（密钥）    ：渠道下的凭证，一个渠道可以有多个 key，轮询使用。
 *  - model（模型）  ：渠道提供的具体模型，可带 alias（别名）。
 *  - registry       ：把「别名 -> 所有能提供该模型的渠道」建成索引，
 *                     于是客户端随便叫 deepseek-r1 / r1 / 原生 id 都能命中。
 */

const path = require('path');
const fs = require('fs');
const { readJson, writeJsonAtomic, expandEnv, readText, writeText, ensureDir, randomId } = require('./util');

const ROOT = path.resolve(__dirname, '..');
// NAS / 容器部署时把「配置」与「数据」指向持久化目录（不改代码，只给环境变量）
const CONFIG_DIR = process.env.GATEWAY_CONFIG_DIR
  ? path.resolve(process.env.GATEWAY_CONFIG_DIR)
  : path.join(ROOT, 'config');
const DATA_DIR = process.env.GATEWAY_DATA_DIR
  ? path.resolve(process.env.GATEWAY_DATA_DIR)
  : path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const PROVIDERS_FILE = path.join(CONFIG_DIR, 'providers.json');
const KEYS_FILE = path.join(CONFIG_DIR, 'keys.json');
const DISCOVERED_FILE = path.join(CONFIG_DIR, 'models.discovered.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const GATEWAY_KEY_FILE = path.join(DATA_DIR, 'gateway-key.txt');
const KEYS_EXAMPLE_FILE = path.join(CONFIG_DIR, 'keys.example.json');

function canonicalName(model) {
  if (Array.isArray(model.alias) && model.alias.length) return String(model.alias[0]).trim();
  return String(model.id).replace(/:free$/i, '').replace(/^@cf\//, '').trim();
}

function loadKeyFile() {
  if (!fs.existsSync(KEYS_FILE)) {
    const example = readJson(KEYS_EXAMPLE_FILE, {});
    const skeleton = {};
    for (const [k, v] of Object.entries(example)) {
      if (k.startsWith('_')) continue;
      skeleton[k] = Array.isArray(v) ? v : [];
    }
    writeJsonAtomic(KEYS_FILE, skeleton);
  }
  const data = readJson(KEYS_FILE, {});
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith('_')) continue;
    out[k] = Array.isArray(v) ? v.filter(Boolean).map(String) : [];
  }
  return out;
}

function parseEnvKeys(envName) {
  if (!envName) return [];
  const raw = process.env[envName];
  if (!raw) return [];
  return String(raw)
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function collectKeys(provider, fileKeys) {
  const fromFile = fileKeys[provider.id] || [];
  const fromEnv = parseEnvKeys(provider.keysEnv);
  const seen = new Set();
  const merged = [];
  for (const k of [...fromEnv, ...fromFile]) {
    const key = String(k).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(key);
  }
  return merged;
}

function loadDiscovered() {
  return readJson(DISCOVERED_FILE, {}) || {};
}

/** 生成/读取客户端访问网关用的 key */
function ensureGatewayKey() {
  ensureDir(DATA_DIR);
  let key = readText(GATEWAY_KEY_FILE, '').trim();
  if (!key) {
    key = `gw-${randomId()}`;
    writeText(GATEWAY_KEY_FILE, key);
  }
  return key;
}

function writeGatewayKey(key) {
  writeText(GATEWAY_KEY_FILE, String(key).trim());
}

function loadConfig() {
  const raw = readJson(PROVIDERS_FILE, null);
  if (!raw) throw new Error(`无法读取配置文件：${PROVIDERS_FILE}`);

  const settings = Object.assign(
    {
      host: '127.0.0.1',
      port: 8787,
      requireClientKey: true,
      maxAttempts: 4,
      requestTimeoutMs: 120000,
      connectTimeoutMs: 15000,
      cooldownBaseMs: 20000,
      cooldownMaxMs: 600000,
      invalidKeyCooldownMs: 1800000,
      statsFlushMs: 5000,
      tzOffsetMinutes: 480,
      defaultMaxTokens: 4096,
      logLimit: 300,
      hourlyRefresh: true,
      autoModelName: 'auto',
    },
    raw.settings || {}
  );

  // 环境变量覆盖：NAS / 容器部署时不用改配置文件也能调整监听地址与端口
  if (process.env.GATEWAY_HOST) settings.host = String(process.env.GATEWAY_HOST);
  if (process.env.GATEWAY_PORT) {
    const p = Number(process.env.GATEWAY_PORT);
    if (Number.isFinite(p) && p > 0) settings.port = p;
  }
  if (process.env.GATEWAY_ADMIN_TOKEN) settings.adminToken = String(process.env.GATEWAY_ADMIN_TOKEN);
  if (process.env.GATEWAY_REQUIRE_CLIENT_KEY === '0') settings.requireClientKey = false;
  if (process.env.GATEWAY_ALLOW_REMOTE_BOOTSTRAP === '1') settings.allowRemoteBootstrap = true;
  if (process.env.GATEWAY_TIMEZONE_OFFSET) {
    const off = Number(process.env.GATEWAY_TIMEZONE_OFFSET);
    if (Number.isFinite(off)) settings.tzOffsetMinutes = off;
  }

  const fileKeys = loadKeyFile();
  const discovered = loadDiscovered();
  const providers = [];

  for (const p of raw.providers || []) {
    const provider = Object.assign({}, p);
    provider.baseUrl = String(expandEnv(provider.baseUrl || '')).replace(/\/+$/, '');
    provider.enabled = provider.enabled !== false;
    provider.keyless = provider.keyless === true;
    provider.keys = provider.keyless ? ['__keyless__'] : collectKeys(provider, fileKeys);
    provider.models = Array.isArray(provider.models) ? provider.models.slice() : [];

    // 合并自动发现出来的模型（不覆盖手工配置的同名模型）
    const extra = discovered[provider.id];
    if (Array.isArray(extra)) {
      const known = new Set(provider.models.map((m) => m.id));
      for (const m of extra) {
        if (!m || !m.id || known.has(m.id)) continue;
        known.add(m.id);
        provider.models.push({
          id: m.id,
          alias: [],
          name: m.name || m.id,
          ctx: m.ctx || 0,
          caps: m.caps || ['chat'],
          discovered: true,
        });
      }
    }

    provider.hasKey = provider.keys.length > 0;
    provider.modelCount = provider.models.length;
    providers.push(provider);
  }

  const cfg = {
    root: ROOT,
    paths: {
      configDir: CONFIG_DIR,
      dataDir: DATA_DIR,
      publicDir: PUBLIC_DIR,
      providersFile: PROVIDERS_FILE,
      keysFile: KEYS_FILE,
      discoveredFile: DISCOVERED_FILE,
      usageFile: USAGE_FILE,
      gatewayKeyFile: GATEWAY_KEY_FILE,
    },
    settings,
    providers,
    gatewayKey: ensureGatewayKey(),
    loadedAt: new Date().toISOString(),
  };

  cfg.registry = buildRegistry(cfg.providers);
  cfg.providerById = new Map(cfg.providers.map((p) => [p.id, p]));

  // 网关自身版本号（fnos/manifest 与 package.json 同源；升级自检用）
  const pkgVer = readJson(path.join(ROOT, 'package.json'), { version: '0.0.0' });
  cfg.version = (pkgVer && pkgVer.version) || '0.0.0';
  return cfg;
}

/**
 * 构建模型索引。
 * registry.models: key(小写规范名) -> { name, caps, ctx, targets:[...] }
 */
function buildRegistry(providers) {
  const models = new Map();
  const aliasIndex = new Map(); // 任何可被请求的名字 -> 规范名

  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      const name = canonicalName(model);
      const key = name.toLowerCase();
      if (!models.has(key)) {
        models.set(key, {
          name,
          caps: new Set(),
          ctx: 0,
          targets: [],
        });
      }
      const entry = models.get(key);
      (model.caps || ['chat']).forEach((c) => entry.caps.add(c));
      entry.ctx = Math.max(entry.ctx, Number(model.ctx) || 0);

      const target = {
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        modelId: model.id,
        display: name,
        priority: Number(provider.priority) || 5,
        caps: model.caps || ['chat'],
        ctx: Number(model.ctx) || 0,
        rpm: Number(model.rpm || provider.rpm) || 0,
        rpd: Number(model.rpd || provider.rpd) || 0,
        discovered: !!model.discovered,
        enabled: true,
      };
      entry.targets.push(target);

      const names = new Set([name, model.id, ...(model.alias || [])]);
      if (!model.discovered) names.add(String(model.id).replace(/:free$/i, ''));
      for (const n of names) {
        if (!n) continue;
        aliasIndex.set(String(n).toLowerCase(), key);
      }
    }
  }

  for (const entry of models.values()) {
    entry.targets.sort((a, b) => b.priority - a.priority);
  }

  return {
    models,
    aliasIndex,
    names: () => Array.from(models.values()).map((m) => m.name),
    resolve(requested) {
      if (!requested) return null;
      const want = String(requested).trim().toLowerCase();
      const key = aliasIndex.get(want);
      if (key && models.has(key)) return models.get(key);
      // 再宽一点：模糊包含匹配
      for (const [alias, k] of aliasIndex.entries()) {
        if (alias.includes(want) || want.includes(alias)) return models.get(k);
      }
      return null;
    },
  };
}

module.exports = {
  loadConfig,
  buildRegistry,
  canonicalName,
  ensureGatewayKey,
  writeGatewayKey,
  ROOT,
  CONFIG_DIR,
  DATA_DIR,
  PUBLIC_DIR,
  PROVIDERS_FILE,
  KEYS_FILE,
  DISCOVERED_FILE,
  USAGE_FILE,
  GATEWAY_KEY_FILE,
  loadKeyFile,
};
