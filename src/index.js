'use strict';

/**
 * 免费模型聚合网关 —— 服务入口。
 *
 * 对外只暴露一个 OpenAI 兼容入口，内部把请求分发给各家免费平台。
 *   POST /v1/chat/completions   对话（支持流式）
 *   POST /v1/embeddings         向量（路由到支持 embedding 的免费渠道）
 *   GET  /v1/models             聚合后的模型清单
 *   GET  /                      Dashboard 监控大屏
 *   /admin/api/*                管理接口（渠道/密钥/统计/日志/自测）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { loadConfig, writeGatewayKey } = require('./config');
const { KeyPool } = require('./pool');
const { Stats } = require('./stats');
const upstream = require('./upstream');
const { discoverAll } = require('./discover');
const { passthrough } = require('./upstream');
const updater = require('./updater');
const eula = require('./eula');
const notify = require('./notify');
const {
  logger,
  maskKey,
  fmtCn,
  readJson,
  writeJsonAtomic,
  redactSecrets,
  estimateMessagesTokens,
} = require('./util');

const log = logger('server');
const { isOwnAddress, isPrivateLan } = require('./net');

/**
 * 这次请求能不能自动拿到管理令牌（dashboard 免配置的关键）。
 *
 * 三档，从严到松：
 *   1. 网关所在机器自己（回环 + 本机网卡地址）——永远放行。飞牛桌面图标走的就是
 *      「本机网卡地址」这一档，只认回环会导致点自己的图标也打不开。
 *   2. 私有网段（家里 / 办公室的内网）——默认放行（`trustLan`，可用
 *      `GATEWAY_TRUST_LAN=0` 关掉）。这是对齐同系列应用的体验：局域网里打开
 *      大屏就能用，不用满 NAS 找令牌。
 *   3. 公网来源——必须显式 `allowRemoteBootstrap: true` 才放行，否则一律拒绝，
 *      端口万一被映射到公网也不会把管理权限漏出去。
 */
function mayAutoIssueToken(settings, ip) {
  if (isOwnAddress(ip)) return true;
  if (settings.trustLan !== false && isPrivateLan(ip)) return true;
  return settings.allowRemoteBootstrap === true;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function createApp(options = {}) {
  const cfg = loadConfig();
  if (options.usageFile) cfg.paths.usageFile = options.usageFile;
  const stats = new Stats({
    file: cfg.paths.usageFile,
    tzOffsetMinutes: cfg.settings.tzOffsetMinutes,
    logLimit: cfg.settings.logLimit,
    flushMs: cfg.settings.statsFlushMs,
  });
  const pool = new KeyPool(cfg.settings);
  pool.sync(cfg.providers);

  const ctx = { cfg, stats, pool };
  let discoveryTimer = null;

  // 同意书状态缓存在进程内：只有本进程会写这个文件，同意后置位即可
  let eulaOk = eula.isAccepted();

  // 把运行上下文交给推送模块：日报汇总、/notify/preview 都依赖它取数
  notify.setContext(ctx);

  function applyConfig(next) {
    ctx.cfg = next;
    ctx.pool.settings = next.settings;
    ctx.pool.tz = next.settings.tzOffsetMinutes;
    ctx.pool.sync(next.providers);
    if (ctx.stats) ctx.stats.tz = next.settings.tzOffsetMinutes;
    return ctx.cfg;
  }

  function reload() {
    const next = loadConfig();
    next.gatewayKey = readGatewayKey(next);
    applyConfig(next);
    log.info(`配置已重载：${next.providers.length} 个渠道，${next.registry.models.size} 个模型`);
    return ctx.cfg;
  }

  function readGatewayKey(nextCfg) {
    try {
      return fs.readFileSync(nextCfg.paths.gatewayKeyFile, 'utf8').trim() || nextCfg.gatewayKey;
    } catch (_e) {
      return nextCfg.gatewayKey;
    }
  }

  function clientKeys() {
    // 网关访问密钥 + 显式配置的管理令牌（NAS 部署时只发一把钥匙给用户，少一层困惑）
    const set = new Set([ctx.cfg.gatewayKey]);
    if (ctx.cfg.settings.adminToken) set.add(String(ctx.cfg.settings.adminToken));
    const extra = ctx.cfg.settings.clientKeys;
    if (Array.isArray(extra)) extra.forEach((k) => set.add(String(k)));
    return set;
  }

  function adminToken() {
    return ctx.cfg.settings.adminToken || ctx.cfg.gatewayKey;
  }

  function isAuthed(req, url) {
    if (!ctx.cfg.settings.requireClientKey) return true;
    const header = req.headers.authorization || '';
    const token = header.replace(/^Bearer\s+/i, '').trim() || String(req.headers['x-api-key'] || '').trim();
    if (token && clientKeys().has(token)) return true;
    const q = url.searchParams.get('key') || url.searchParams.get('api_key');
    return Boolean(q && clientKeys().has(q));
  }

  function isAdmin(req, url) {
    const token = String(req.headers['x-admin-token'] || url.searchParams.get('token') || '').trim();
    return token && token === adminToken();
  }

  // ---------------------------------------------------------------- HTTP utils
  function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-api-key,x-admin-token,Accept,anthropic-version');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  function sendJson(res, status, obj, extraHeaders) {
    if (res.writableEnded) return;
    const text = JSON.stringify(obj, null, 2);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    }, extraHeaders || {}));
    res.end(text);
  }

  function sendText(res, status, text, contentType) {
    if (res.writableEnded) return;
    res.writeHead(status, {
      'Content-Type': contentType || 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  function readBody(req, limit = 24 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const full = path.join(ctx.cfg.paths.publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!full.startsWith(ctx.cfg.paths.publicDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const body = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }

  // ------------------------------------------------------------------ 业务接口
  function modelsPayload() {
    const created = Math.floor(Date.now() / 1000);
    const data = [];
    data.push({
      id: 'auto',
      object: 'model',
      created,
      owned_by: 'gateway',
      description: '自动路由：按渠道健康度实时挑一个可用的免费模型',
      capabilities: ['chat', 'auto'],
      providers: ctx.cfg.providers.filter((p) => p.enabled).length,
    });
    for (const tag of ['reason', 'code', 'fast', 'long', 'vision']) {
      data.push({
        id: `auto:${tag}`,
        object: 'model',
        created,
        owned_by: 'gateway',
        description: `自动路由（能力标签：${tag}）`,
        capabilities: ['chat', 'auto', tag],
        providers: ctx.cfg.providers.filter((p) => p.enabled).length,
      });
    }
    for (const entry of ctx.cfg.registry.models.values()) {
      const providers = Array.from(new Set(entry.targets.map((t) => t.providerName)));
      data.push({
        id: entry.name,
        object: 'model',
        created,
        owned_by: providers[0] || 'gateway',
        description: `${providers.length} 个渠道可提供：${providers.join(' / ')}`,
        capabilities: Array.from(entry.caps),
        context_length: entry.ctx || undefined,
        providers: providers.length,
        provider_ids: Array.from(new Set(entry.targets.map((t) => t.providerId))),
      });
    }
    return { object: 'list', data };
  }

  async function handleChat(req, res, url) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: { message: err.message, type: 'invalid_request_error' } });
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_e) {
      sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
      return;
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      sendJson(res, 400, {
        error: { message: 'messages 字段必填，且必须是非空数组', type: 'invalid_request_error' },
      });
      return;
    }
    if (!body.max_tokens && !body.max_completion_tokens) {
      body.max_tokens = ctx.cfg.settings.defaultMaxTokens;
    }
    body.__gateway = { client: req.headers['user-agent'] || '', ip: req.socket.remoteAddress };

    const stream = body.stream === true || String(body.stream) === 'true';

    // 客户端断开立即中止上游，避免空跑 token / 占用密钥并发
    const clientAc = new AbortController();
    req.on('close', () => clientAc.abort());

    const result = await upstream.execute(ctx, {
      body,
      stream,
      nodeRes: stream ? res : null,
      clientTag: (req.headers['user-agent'] || '').slice(0, 60),
      clientSignal: clientAc.signal,
    });

    if (result.ok) {
      if (result.streamed) return;
      const payload = Object.assign({}, result.json);
      payload.x_gateway = {
        provider: result.provider.id,
        provider_name: result.provider.name,
        upstream_model: result.target.modelId,
        route: result.route,
        attempts: result.attempts.length,
        latency_ms: result.latencyMs,
      };
      sendJson(res, 200, payload);
      return;
    }

    log.warn(`请求失败 model=${body.model} → ${result.status}: ${String(result.error && result.error.message).slice(0, 200)}`);
    sendJson(res, result.status, { error: result.error, x_gateway: { route: result.route, attempts: result.attempts } });
  }

  async function handleEmbeddings(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (_e) {
      sendJson(res, 400, { error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
      return;
    }
    const candidates = ctx.cfg.providers.filter(
      (p) => p.enabled && p.embeddings && (p.keyless || p.keys.length)
    );
    if (!candidates.length) {
      sendJson(res, 501, {
        error: {
          message: '当前没有配置支持 embedding 的免费渠道。可在 config/providers.json 给某渠道加 "embeddings": true 与 "embeddingModels": ["模型名"] 后重试。',
          type: 'gateway_error',
          code: 'no_embedding_channel',
        },
      });
      return;
    }
    const attempts = [];
    for (const provider of candidates) {
      const keyState = ctx.pool.acquire(provider.id);
      if (!keyState) continue;
      const modelId = (provider.embeddingModels && provider.embeddingModels[0]) || body.model;
      const r = await passthrough(ctx.cfg, provider, keyState.key, { kind: 'embeddings', body, modelId });
      ctx.pool.report(keyState, {
        ok: r.ok,
        kind: r.ok ? undefined : 'server',
        status: r.status,
        error: r.ok ? '' : JSON.stringify(r.json).slice(0, 200),
      });
      ctx.pool.release(keyState);
      attempts.push({ provider: provider.name, ok: r.ok, status: r.status });
      if (r.ok) {
        sendJson(res, 200, r.json);
        return;
      }
    }
    sendJson(res, 502, { error: { message: '所有 embedding 渠道均失败', attempts } });
  }

  // ------------------------------------------------------------------ 管理接口
  function providerView() {
    return ctx.cfg.providers.map((p) => {
      const health = ctx.pool.providerStatus(p.id);
      const usage = ctx.stats.data.byProvider[p.id] || { calls: 0, ok: 0, failed: 0, input: 0, output: 0 };
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        enabled: p.enabled,
        keyless: !!p.keyless,
        baseUrl: p.baseUrl,
        homepage: p.homepage || '',
        note: p.note || '',
        priority: p.priority,
        rpm: p.rpm || 0,
        rpd: p.rpd || 0,
        keys: ctx.pool.describe()[p.id] || [],
        hasKey: !!p.hasKey,
        modelCount: p.models.length,
        modelsLabel: p.models.length ? `${p.models.length} 个模型` : (p.discover ? '等待自动发现' : '未配置模型'),
        health,
        usage,
      };
    });
  }

  function overview() {
    const snap = ctx.stats.snapshot();
    const providers = providerView();
    const realProviders = providers.filter((p) => p.id !== 'mock' && p.type !== 'mock');
    const lastCheck = updater.getLastCheck();
    return {
      generatedAt: new Date().toISOString(),
      gateway: {
        host: ctx.cfg.settings.host,
        port: ctx.cfg.settings.port,
        baseUrl: `http://${ctx.cfg.settings.host}:${ctx.cfg.settings.port}/v1`,
        clientKey: ctx.cfg.settings.requireClientKey
          ? (ctx.cfg.settings.adminToken || ctx.cfg.gatewayKey)
          : '(未开启校验，任意 key 均可)',
        requireClientKey: !!ctx.cfg.settings.requireClientKey,
        startedAt: ctx.stats.data.meta.startedAt,
        uptimeSec: Math.round(process.uptime()),
        nodeVersion: process.version,
        version: ctx.cfg.version,
        update: lastCheck ? {
          hasUpdate: !!lastCheck.hasUpdate,
          latest: lastCheck.latest || ctx.cfg.version,
          sourceLabel: lastCheck.sourceLabel || '',
          checkedAt: lastCheck.at || 0,
        } : { hasUpdate: false, latest: ctx.cfg.version },
      },
      stats: Object.assign({}, snap, {
        inputText: fmtCn(snap.totals.inputTokens),
        outputText: fmtCn(snap.totals.outputTokens),
        totalText: fmtCn(snap.totals.totalTokens),
        callsText: snap.totals.calls.toLocaleString('en-US'),
      }),
      providers,
      summary: {
        providers: providers.length,
        providersEnabled: providers.filter((p) => p.enabled).length,
        providersWithKey: realProviders.filter((p) => p.hasKey || p.keyless).length,
        models: ctx.cfg.registry.models.size,
        keys: providers.reduce((s, p) => s + p.keys.length, 0),
        healthyKeys: providers.reduce((s, p) => s + p.keys.filter((k) => k.status === 'ok').length, 0),
      },
      recentLogs: ctx.stats.recentLogs(40),
      discoveredAt: (readJson(ctx.cfg.paths.discoveredFile, {}) || {}).__updatedAt || '',
    };
  }

  // 初始化自动更新子系统（读取更新配置、启动定时检查）
  try { updater.init(ctx); } catch (_e) { /* 更新子系统可选，初始化失败不影响主服务 */ }

  // 管理接口处理（由 route 通过 await handleAdmin(...) 调用）
  async function handleAdmin(req, res, url, pathname) {
    // 打开 Dashboard 时自动取一次令牌。判定见 mayAutoIssueToken()：
    // 网关所在机器自己 → 永远放行；同一私有网段 → 默认放行（trustLan）；
    // 公网来源 → 必须显式 allowRemoteBootstrap 才放行。
    if (pathname === '/admin/api/bootstrap') {
      const ip = String(req.socket.remoteAddress || '');
      const local = isOwnAddress(ip);
      if (mayAutoIssueToken(ctx.cfg.settings, ip)) {
        sendJson(res, 200, { token: adminToken(), local });
      } else {
        sendJson(res, 403, {
          error: {
            message: '出于安全考虑，只有内网来源才会自动下发管理令牌（当前请求来自公网地址）。请用 http://<网关地址>:8790/?token=<管理令牌> 打开（令牌在数据目录的 gateway-key.txt 里，也打印在启动日志中），或在页面右上角齿轮里手工填入；确有需要可在 config/providers.json 的 settings 里设 "allowRemoteBootstrap": true。',
            code: 'bootstrap_forbidden',
          },
        });
      }
      return;
    }

    // 同意书正文是公开的法律文本（仓库根目录另有一份 DISCLAIMER.md）。
    // 这里刻意不校验管理令牌：令牌失效时若连条款都读不到，用户会卡在一个
    // 看不懂的报错上——既不知道要同意什么，也没法自己修，等于装完打不开。
    if (pathname === '/admin/api/eula' && req.method === 'GET') {
      sendJson(res, 200, Object.assign({}, eula.getState(), { text: eula.getFullText() }));
      return;
    }

    if (!isAdmin(req, url)) {
      sendJson(res, 401, { error: { message: '管理令牌无效，请使用 ?token=<管理令牌> 或 x-admin-token 请求头', type: 'auth_error' } });
      return;
    }

    if (pathname === '/admin/api/overview' || pathname === '/admin/api/stats') {
      sendJson(res, 200, overview());
      return;
    }

    if (pathname === '/admin/api/models') {
      sendJson(res, 200, modelsPayload());
      return;
    }

    if (pathname === '/admin/api/logs') {
      const limit = Number(url.searchParams.get('limit') || 60);
      sendJson(res, 200, { logs: ctx.stats.recentLogs(Math.max(1, Math.min(300, limit))) });
      return;
    }

    if (pathname === '/admin/api/keys' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (_e) {
        sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
        return;
      }
      const providerId = String(body.providerId || '').trim();
      const provider = ctx.cfg.providerById.get(providerId);
      if (!provider) {
        sendJson(res, 404, { error: { message: `没有这个渠道：${providerId}` } });
        return;
      }
      const add = body.keys
        ? (Array.isArray(body.keys) ? body.keys : [body.keys])
        : (body.key ? [body.key] : []);
      const clean = add.map((k) => String(k).trim()).filter(Boolean);
      if (!clean.length && body.action !== 'replace') {
        sendJson(res, 400, { error: { message: '缺少 keys 字段（可以是字符串或数组）' } });
        return;
      }
      const store = readJson(ctx.cfg.paths.keysFile, {}) || {};
      const current = body.action === 'replace' ? [] : (Array.isArray(store[providerId]) ? store[providerId] : []);
      const merged = Array.from(new Set([...current, ...clean]));
      store[providerId] = merged;
      writeJsonAtomic(ctx.cfg.paths.keysFile, store);
      reload();
      sendJson(res, 200, {
        ok: true,
        providerId,
        count: merged.length,
        masked: merged.map(maskKey),
        message: `已为 ${provider.name} 保存 ${merged.length} 个密钥`,
      });
      return;
    }

    if (pathname === '/admin/api/keys' && req.method === 'DELETE') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (_e) {
        body = {};
      }
      const providerId = String(body.providerId || url.searchParams.get('providerId') || '').trim();
      const target = String(body.key || url.searchParams.get('key') || '').trim();
      if (!providerId) {
        sendJson(res, 400, { error: { message: '缺少 providerId' } });
        return;
      }
      const store = readJson(ctx.cfg.paths.keysFile, {}) || {};
      const current = Array.isArray(store[providerId]) ? store[providerId] : [];
      const next = target ? current.filter((k) => k !== target && maskKey(k) !== target) : [];
      store[providerId] = next;
      writeJsonAtomic(ctx.cfg.paths.keysFile, store);
      reload();
      sendJson(res, 200, { ok: true, providerId, count: next.length });
      return;
    }

    if (pathname === '/admin/api/provider-toggle' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (_e) {
        sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
        return;
      }
      const fileCfg = readJson(ctx.cfg.paths.providersFile, null);
      const target = fileCfg && (fileCfg.providers || []).find((p) => p.id === body.providerId);
      if (!target) {
        sendJson(res, 404, { error: { message: `没有这个渠道：${body.providerId}` } });
        return;
      }
      target.enabled = !!body.enabled;
      writeJsonAtomic(ctx.cfg.paths.providersFile, fileCfg);
      reload();
      sendJson(res, 200, { ok: true, providerId: body.providerId, enabled: target.enabled });
      return;
    }

    if (pathname === '/admin/api/reload' && req.method === 'POST') {
      reload();
      sendJson(res, 200, { ok: true, providers: ctx.cfg.providers.length, models: ctx.cfg.registry.models.size });
      return;
    }

    if (pathname === '/admin/api/discover' && req.method === 'POST') {
      const results = await discoverAll(ctx.cfg, {});
      reload();
      sendJson(res, 200, { ok: true, results, models: ctx.cfg.registry.models.size });
      return;
    }

    if (pathname === '/admin/api/test' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (_e) { /* 允许空体 */ }
      const model = body.model || 'auto';
      const prompt = body.prompt || '用一句话介绍你自己，并说明你来自哪个渠道。';
      const started = Date.now();
      const result = await upstream.execute(ctx, {
        body: {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: body.max_tokens || 256,
          temperature: 0.3,
        },
        stream: false,
        nodeRes: null,
        clientTag: 'admin-test',
      });
      sendJson(res, 200, {
        ok: result.ok,
        model,
        latencyMs: Date.now() - started,
        provider: result.provider ? result.provider.name : '',
        upstreamModel: result.target ? result.target.modelId : '',
        content: result.ok ? ((result.json.choices && result.json.choices[0] && result.json.choices[0].message.content) || '') : '',
        usage: result.usage || null,
        attempts: result.attempts,
        error: result.ok ? null : result.error,
      });
      return;
    }

    if (pathname === '/admin/api/reset-stats' && req.method === 'POST') {
      ctx.stats.reset();
      sendJson(res, 200, { ok: true, message: '统计已清零' });
      return;
    }

    if (pathname === '/admin/api/gateway-key' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (_e) { /* ignore */ }
      if (body.key && String(body.key).trim()) {
        writeGatewayKey(String(body.key).trim());
        ctx.cfg.gatewayKey = String(body.key).trim();
      }
      sendJson(res, 200, { ok: true, clientKey: ctx.cfg.gatewayKey });
      return;
    }

    if (pathname === '/admin/api/export') {
      sendJson(res, 200, {
        exportedAt: new Date().toISOString(),
        usage: ctx.stats.data,
        providers: ctx.cfg.providers.map((p) => ({
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          keys: p.keyless ? ['(keyless)'] : p.keys.map(maskKey),
          models: p.models.map((m) => m.id),
        })),
      }, { 'Content-Disposition': 'attachment; filename="gateway-export.json"' });
      return;
    }

    // ---- 自动更新相关 ----
    if (pathname === '/admin/api/version') {
      sendJson(res, 200, { version: ctx.cfg.version, update: updater.getLastCheck() || {} });
      return;
    }
    if (pathname === '/admin/api/update' && req.method === 'GET') {
      sendJson(res, 200, updater.getLastCheck() || { hasUpdate: false });
      return;
    }
    if (pathname === '/admin/api/update/check' && req.method === 'POST') {
      try {
        sendJson(res, 200, await updater.checkUpdate({ force: true }));
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (pathname === '/admin/api/update/status' && req.method === 'GET') {
      sendJson(res, 200, updater.getUpdateStatus());
      return;
    }
    if (pathname === '/admin/api/update/backups' && req.method === 'GET') {
      try { sendJson(res, 200, { backups: await updater.listBackups() }); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (pathname === '/admin/api/update/apply' && req.method === 'POST') {
      try {
        const r = await updater.performUpdate();
        if (r.error) return sendJson(res, 409, r);
        sendJson(res, 200, r);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (pathname === '/admin/api/update/rollback' && req.method === 'POST') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_e) { body = {}; }
      try {
        const r = await updater.rollback(body.version);
        if (r.error) return sendJson(res, 400, r);
        sendJson(res, 200, r);
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (pathname === '/admin/api/update/config' && req.method === 'PUT') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_e) { body = {}; }
      try { sendJson(res, 200, await updater.saveUpdateConfig(body)); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }
    if (pathname === '/admin/api/update/config' && req.method === 'GET') {
      sendJson(res, 200, updater.getUpdateConfig());
      return;
    }

    // ---- 用户许可与免责同意书 ----
    // 注意：GET /admin/api/eula 在鉴权之前就已处理（见上），此处只剩「同意」这个写操作。
    if (pathname === '/admin/api/eula/accept' && req.method === 'POST') {
      const r = eula.accept({
        from: String(req.socket.remoteAddress || ''),
        agent: req.headers['user-agent'] || '',
      });
      if (!r.ok) {
        sendJson(res, 500, { error: { message: r.error } });
        return;
      }
      eulaOk = true;
      log.info('[eula] 用户已同意《用户许可与免责同意书》');
      sendJson(res, 200, { ok: true, state: r.state });
      return;
    }

    // ---- 每日用量推送（PushPlus）----
    if (pathname === '/admin/api/notify/config' && req.method === 'GET') {
      sendJson(res, 200, notify.getConfig());
      return;
    }
    if (pathname === '/admin/api/notify/config' && req.method === 'PUT') {
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch (_e) { body = {}; }
      const r = notify.saveConfig(body);
      if (r.error) { sendJson(res, 400, { error: { message: r.error } }); return; }
      sendJson(res, 200, r.config);
      return;
    }
    if (pathname === '/admin/api/notify/preview' && req.method === 'GET') {
      sendJson(res, 200, notify.preview());
      return;
    }
    if (pathname === '/admin/api/notify/test' && req.method === 'POST') {
      try { sendJson(res, 200, await notify.sendTest()); }
      catch (err) { sendJson(res, 500, { error: { message: err.message } }); }
      return;
    }
    if (pathname === '/admin/api/notify/send' && req.method === 'POST') {
      try { sendJson(res, 200, await notify.sendDaily({ force: true, reason: 'manual' })); }
      catch (err) { sendJson(res, 500, { error: { message: err.message } }); }
      return;
    }

    sendJson(res, 404, { error: { message: `未知管理接口：${pathname}` } });
  }

  // -------------------------------------------------------------------- 路由表
  async function route(req, res) {
    setCors(res);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- 首次使用必须同意《用户许可与免责同意书》----
    // 静态资源与 /healthz 放行，保证 Dashboard 能打开并弹出同意书；
    // /v1/* 与管理接口（eula / bootstrap 自身除外）在同意前一律拒绝。
    if (!eulaOk) {
      const eulaSelf = pathname === '/admin/api/eula'
        || pathname === '/admin/api/eula/accept'
        || pathname === '/admin/api/bootstrap';
      const gated = pathname.startsWith('/v1/') || (pathname.startsWith('/admin/api/') && !eulaSelf);
      if (gated) {
        sendJson(res, 403, {
          error: {
            message: '首次使用前需阅读并同意《用户许可与免责同意书》，请打开监控大屏完成确认。',
            type: 'eula_required',
            code: 'eula_required',
          },
        });
        return;
      }
    }

    try {
      if (pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          version: ctx.cfg.version,
          uptimeSec: Math.round(process.uptime()),
          providers: ctx.cfg.providers.filter((p) => p.enabled).length,
          models: ctx.cfg.registry.models.size,
          calls: ctx.stats.data.totals.calls,
        });
        return;
      }

      if (pathname.startsWith('/admin')) {
        if (pathname === '/admin' || pathname === '/admin/') {
          serveStatic(req, res, '/index.html');
          return;
        }
        if (pathname.startsWith('/admin/api/')) {
          await handleAdmin(req, res, url, pathname);
          return;
        }
        serveStatic(req, res, pathname.replace(/^\/admin/, '') || '/');
        return;
      }

      // ---- OpenAI 兼容接口 ----
      if (pathname.startsWith('/v1/')) {
        if (!isAuthed(req, url)) {
          sendJson(res, 401, {
            error: {
              message: '缺少或错误的 API Key。请在 Authorization: Bearer <key> 中带上网关访问密钥（见 Dashboard 顶部「接入信息」）。',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          });
          return;
        }
        if (pathname === '/v1/models' && req.method === 'GET') {
          sendJson(res, 200, modelsPayload());
          return;
        }
        if ((pathname === '/v1/chat/completions' || pathname === '/v1/completions') && req.method === 'POST') {
          await handleChat(req, res, url);
          return;
        }
        if (pathname === '/v1/embeddings' && req.method === 'POST') {
          await handleEmbeddings(req, res);
          return;
        }
        sendJson(res, 404, { error: { message: `网关暂不支持该接口：${pathname}`, type: 'invalid_request_error' } });
        return;
      }

      if (req.method === 'GET') {
        serveStatic(req, res, pathname);
        return;
      }

      sendJson(res, 404, { error: { message: 'Not Found' } });
    } catch (err) {
      log.error('未捕获异常:', err.stack || err.message);
      if (!res.writableEnded) {
        sendJson(res, 500, { error: { message: `网关内部错误：${redactSecrets(err.message)}`, type: 'gateway_error' } });
      }
    }
  }

  const server = http.createServer((req, res) => {
    res.on('close', () => { /* 客户端断开时上游会因为 res.writableEnded 停止写入 */ });
    route(req, res);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  function startHourlyRefresh() {
    if (!ctx.cfg.settings.hourlyRefresh) return;
    const run = async () => {
      try {
        const results = await discoverAll(ctx.cfg, {});
        const changed = results.some((r) => r.ok && r.added >= 0);
        if (changed) reload();
      } catch (err) {
        log.warn(`定时发现失败：${err.message}`);
      }
    };
    discoveryTimer = setInterval(run, 3600000);
    if (discoveryTimer.unref) discoveryTimer.unref();
    setTimeout(run, 12000).unref?.();
  }

  return {
    ctx,
    server,
    reload,
    startHourlyRefresh,
    close() {
      if (discoveryTimer) clearInterval(discoveryTimer);
      try { notify.stopScheduler(); } catch (_e) { /* 忽略 */ }
      stats.close();
    },
  };
}

function main() {
  const app = createApp();
  const { cfg } = app.ctx;
  app.server.listen(cfg.settings.port, cfg.settings.host, () => {
    const realKeys = cfg.providers.filter((p) => !p.keyless && p.type !== 'mock' && p.keys.length).length;
    log.info('免费模型聚合网关已启动');
    log.info(`  Dashboard : http://${cfg.settings.host}:${cfg.settings.port}/`);
    log.info(`  API Base  : http://${cfg.settings.host}:${cfg.settings.port}/v1`);
    log.info(`  访问密钥   : ${cfg.gatewayKey}`);
    log.info(`  渠道/模型  : ${cfg.providers.length} 个渠道（${realKeys} 个已配密钥） / ${cfg.registry.models.size} 个模型`);
    if (!realKeys) {
      log.warn('尚未配置任何真实密钥，当前只有内置模拟渠道可用。把密钥写进 config/keys.json 或环境变量后重启即可。');
    }
    app.startHourlyRefresh();
  });

  // SIGHUP：不中断服务地热重载渠道配置（等效于 /admin/api/reload，但无需令牌）
  process.on('SIGHUP', () => {
    try { app.reload(); log.info('收到 SIGHUP，已热重载配置'); }
    catch (err) { log.error('SIGHUP 重载失败：', err.message); }
  });

  // 启动自动更新检查（每 6 小时一次；可在 Dashboard 关闭）
  try { updater.startAutoUpdateCheck(); } catch (_e) { /* 自动更新为可选能力 */ }

  // 启动每日用量推送调度（默认关闭；在 Dashboard「每日推送」中开启后生效）
  try { notify.startScheduler(app.ctx); } catch (_e) { /* 推送为可选能力 */ }

  const shutdown = (signal) => {
    log.info(`收到 ${signal}，正在退出…`);
    app.close();
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { createApp };
