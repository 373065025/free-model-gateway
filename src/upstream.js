'use strict';

/**
 * 路由与故障转移引擎。
 *
 * 一次客户端请求会经历：
 *   解析模型名 → 排出候选渠道链 → 逐个尝试（换 key / 换渠道 / 换模型）
 *   → 成功则返回，全部失败则返回结构化错误（附带每次尝试的诊断信息）。
 *
 * 流式请求也一样：只要上游还没吐出任何字节就被判失败，就可以无缝换下一个渠道。
 */

const { Readable } = require('stream');
const {
  buildRequest,
  normalizeResponse,
  usageFrom,
  parseSseLine,
  deltaText,
  anthropicEventToOpenAI,
  mockCompletion,
} = require('./adapters');
const {
  classifyError,
  RETRYABLE,
  estimateMessagesTokens,
  estimateTokens,
  extractOutputText,
  backoffMs,
  sleep,
  redactSecrets,
  logger,
  nowMs,
} = require('./util');

const log = logger('upstream');

const MOCK_LATENCY_MS = 160;
const MOCK_CHUNK_DELAY_MS = 28;

/** 把请求的模型名解析成候选目标链 */
function resolveTargets(cfg, pool, requested) {
  const settings = cfg.settings;
  const raw = String(requested || '').trim();
  const autoNames = new Set([settings.autoModelName || 'auto', 'auto', 'free', 'best', 'default', 'free-router']);

  if (!raw || autoNames.has(raw.toLowerCase())) {
    return { mode: 'auto', requested: raw || 'auto', display: 'auto', targets: autoTargets(cfg, pool, {}) };
  }
  if (/^(auto|best):/i.test(raw)) {
    const tag = raw.split(':')[1].trim().toLowerCase();
    return {
      mode: 'auto',
      requested: raw,
      display: `auto:${tag}`,
      targets: autoTargets(cfg, pool, { tag }),
    };
  }

  const entry = cfg.registry.resolve(raw);
  if (!entry) {
    return {
      mode: 'exact',
      requested: raw,
      display: raw,
      targets: [],
      notFound: true,
      suggestions: cfg.registry.names().slice(0, 40),
    };
  }

  const targets = entry.targets
    .map((t) => Object.assign({}, t, { score: pool.targetScore(t.providerId, t.priority) }))
    .sort((a, b) => b.score - a.score);

  return { mode: 'exact', requested: raw, display: entry.name, targets };
}

/**
 * auto 模式候选链：真实渠道按「健康度评分」降序排在前，
 * 内置模拟渠道固定殿后兜底（不参与评分竞争，避免因优先级低被挤出候选链）。
 */
function autoTargets(cfg, pool, { tag } = {}) {
  const want = tag ? [tag] : ['chat'];
  const models = Array.from(cfg.registry.models.values()).filter((m) => want.every((c) => m.caps.has(c)));

  const isMockModel = (m) => m.targets.length > 0 && m.targets.every((t) => t.providerType === 'mock');
  const bestScore = (m) => m.targets.reduce((acc, t) => Math.max(acc, pool.targetScore(t.providerId, t.priority)), -Infinity);
  const byScore = (m) => m.targets
    .slice()
    .sort((a, b) => pool.targetScore(b.providerId, b.priority) - pool.targetScore(a.providerId, a.priority));

  const ranked = models.map((m) => ({ m, best: bestScore(m) })).sort((a, b) => b.best - a.best);

  const real = [];
  for (const { m } of ranked) {
    if (isMockModel(m)) continue;
    for (const t of byScore(m).slice(0, 2)) real.push(t); // 每个模型最多贡献 2 个渠道，保证候选链有多样性
    if (real.length >= 14) break;
  }

  const fallback = [];
  for (const { m } of ranked) {
    if (!isMockModel(m)) continue;
    for (const t of byScore(m).slice(0, 2)) fallback.push(t);
  }

  return real.concat(fallback);
}

/** 过滤掉配置里不存在或被禁用/无密钥的渠道 */
function usableTargets(cfg, targets) {
  const out = [];
  for (const t of targets) {
    const provider = cfg.providerById.get(t.providerId);
    if (!provider || !provider.enabled) continue;
    if (!provider.keyless && !provider.keys.length) continue;
    if (!provider.models.length && provider.type !== 'mock') continue;
    out.push(Object.assign({}, t, { provider }));
  }
  return out;
}

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/**
 * 把多个 AbortSignal 合并成一个：任意一个触发 abort，合并信号也触发。
 * 用于把「超时」和「客户端断开」两路信号同时作用到一次 fetch 上。
 * 不依赖 AbortSignal.any（Node 18 不一定有），手动串联。
 */
function combineSignals(signals) {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl;
}

/**
 * 执行一次客户端请求（含故障转移）。
 *
 * @param {object} ctx   { cfg, pool, stats }
 * @param {object} opts
 * @param {object} opts.body            请求体（OpenAI 形状）
 * @param {boolean} opts.stream
 * @param {object|null} opts.nodeRes    流式时直接写入的对象（http.ServerResponse）
 * @returns {Promise<object>} 统一结果
 */
async function execute(ctx, opts) {
  const { cfg, pool } = ctx;
  const settings = cfg.settings;
  const started = nowMs();
  const requestedModel = opts.body && opts.body.model;
  const stream = !!opts.stream;

  const plan = resolveTargets(cfg, pool, requestedModel);
  const attempts = [];

  if (plan.notFound) {
    ctx.stats.record({
      ok: false,
      model: plan.display,
      providerId: '',
      inputTokens: estimateMessagesTokens(opts.body.messages),
      outputTokens: 0,
      latencyMs: 0,
      stream,
      error: 'model_not_found',
    });
    return {
      ok: false,
      status: 404,
      error: {
        message: `网关里没有找到模型「${requestedModel}」。可用模型见 GET /v1/models，或直接用 "auto" 让网关自动挑一个。`,
        type: 'invalid_request_error',
        code: 'model_not_found',
        available_models: plan.suggestions,
      },
      attempts,
      modelName: plan.display,
      route: plan.mode,
    };
  }

  // auto 模式的候选链已经保证「真实渠道在前、内置兜底渠道殿后」，
  // 显式指定模型名时则完全按模型自己的渠道优先级来。
  const candidates = usableTargets(cfg, plan.targets);
  if (!candidates.length) {
    ctx.stats.record({
      ok: false,
      model: plan.display,
      providerId: '',
      inputTokens: estimateMessagesTokens(opts.body.messages),
      outputTokens: 0,
      latencyMs: 0,
      stream,
      error: 'no_channel',
    });
    return {
      ok: false,
      status: 503,
      error: {
        message: '当前没有任何可用渠道：请在 config/keys.json 或环境变量里配置至少一个免费平台的密钥（或启动本地 Ollama）。',
        type: 'gateway_error',
        code: 'no_available_channel',
      },
      attempts,
      modelName: plan.display,
      route: plan.mode,
    };
  }

  const maxAttempts = Math.max(1, Math.min(settings.maxAttempts || 4, candidates.length));
  let lastError = null;
  let lastStatus = 502;
  let skippedBusy = 0;
  const inputEstimate = estimateMessagesTokens(opts.body.messages);

  for (let i = 0; i < maxAttempts; i += 1) {
    const target = candidates[i];
    const provider = target.provider;
    const keyState = pool.acquire(provider.id);
    if (!keyState) {
      // 该渠道的密钥全在冷却/限流/并发打满中：直接跳过，不计为一次真实的上游尝试
      skippedBusy += 1;
      log.warn(`跳过渠道 ${provider.name}：所有密钥都在冷却 / 限流 / 并发打满中`);
      continue;
    }

    const attemptStarted = nowMs();
    try {
      const result = await attemptOnce(ctx, {
        target,
        provider,
        keyState,
        body: opts.body,
        stream,
        nodeRes: opts.nodeRes,
        inputEstimate,
        clientSignal: opts.clientSignal,
      });

      if (result.ok) {
        const latencyMs = nowMs() - attemptStarted;
        const usage = result.usage || { input: inputEstimate, output: 0 };
        pool.report(keyState, { ok: true, latencyMs });
        pool.noteUsage(keyState, usage.input, usage.output);
        if (!result.streamed) pool.release(keyState); // 流式请求在 streamAttempt 收尾时释放
        attempts.push({
          provider: provider.name,
          providerId: provider.id,
          model: target.modelId,
          ok: true,
          latencyMs,
          tokens: usage.input + usage.output,
        });
        ctx.stats.record({
          ok: true,
          model: plan.display,
          providerId: provider.id,
          providerName: provider.name,
          inputTokens: usage.input,
          outputTokens: usage.output,
          latencyMs: nowMs() - started,
          stream,
          attempts: i + 1,
          route: plan.mode,
          client: opts.clientTag || '',
        });
        return {
          ok: true,
          status: 200,
          json: result.json,
          streamed: !!result.streamed,
          usage,
          target,
          provider,
          modelName: plan.display,
          route: plan.mode,
          attempts,
          latencyMs: nowMs() - started,
        };
      }

      const latencyMs = nowMs() - attemptStarted;
      const kind = result.kind || 'server';
      pool.report(keyState, {
        ok: false,
        kind,
        status: result.status,
        error: result.errorText,
        retryAfterMs: result.retryAfterMs,
        latencyMs,
      });
      pool.release(keyState);
      attempts.push({
        provider: provider.name,
        providerId: provider.id,
        model: target.modelId,
        ok: false,
        status: result.status,
        kind,
        latencyMs,
        error: redactSecrets(String(result.errorText || '').slice(0, 300)),
      });
      lastError = result.errorText;
      lastStatus = result.status || 502;

      log.warn(`渠道 ${provider.name} / ${target.modelId} 失败(${kind} ${result.status}): ${redactSecrets(String(result.errorText || '').slice(0, 200))}`);

      if (!RETRYABLE.has(kind)) {
        break; // 客户端请求本身有问题，换渠道也没用
      }
      if (i < maxAttempts - 1) {
        await sleep(Math.min(800, backoffMs(150, i + 1, 800)));
      }
    } catch (err) {
      const latencyMs = nowMs() - attemptStarted;
      const kind = /abort/i.test(String(err.name || err.message)) ? 'timeout' : 'network';
      pool.report(keyState, { ok: false, kind: 'server', error: err.message, latencyMs });
      pool.release(keyState);
      attempts.push({
        provider: provider.name,
        providerId: provider.id,
        model: target.modelId,
        ok: false,
        kind,
        latencyMs,
        error: redactSecrets(String(err.message || err)),
      });
      lastError = err.message;
      lastStatus = 504;
      log.warn(`渠道 ${provider.name} 异常: ${err.message}`);
    }
  }

  ctx.stats.record({
    ok: false,
    model: plan.display,
    providerId: '',
    inputTokens: inputEstimate,
    outputTokens: 0,
    latencyMs: nowMs() - started,
    stream,
    attempts: attempts.length,
    route: plan.mode,
    error: redactSecrets(String(lastError || 'all_channels_failed')).slice(0, 200),
  });

  // 所有候选渠道都因为「密钥冷却/限流/并发打满」被跳过：这是瞬时拥塞，给客户端一个可重试的 503
  if (attempts.length === 0 && skippedBusy > 0) {
    return {
      ok: false,
      status: 503,
      error: {
        message: '当前所有渠道的密钥都处于冷却、限流或并发上限状态，请稍后重试（网关会自动错峰重试）。',
        type: 'upstream_error',
        code: 'all_keys_busy',
        attempts,
      },
      attempts,
      modelName: plan.display,
      route: plan.mode,
      latencyMs: nowMs() - started,
    };
  }

  return {
    ok: false,
    status: lastStatus === 429 ? 429 : lastStatus >= 400 && lastStatus < 500 ? lastStatus : 502,
    error: {
      message: `所有候选渠道都失败了（尝试了 ${attempts.length} 个）。最后一次错误：${redactSecrets(String(lastError || '未知错误')).slice(0, 400)}`,
      type: 'upstream_error',
      code: 'all_channels_failed',
      attempts,
    },
    attempts,
    modelName: plan.display,
    route: plan.mode,
    latencyMs: nowMs() - started,
  };
}

/**
 * 单次尝试。流式走 nodeRes 直写，非流式返回 json。
 */
async function attemptOnce(ctx, o) {
  const { cfg } = ctx;
  const { target, provider, keyState, body, stream, nodeRes, inputEstimate, clientSignal } = o;

  if (provider.type === 'mock') {
    return mockAttempt({ target, provider, body, stream, nodeRes, inputEstimate });
  }

  const req = buildRequest({
    provider,
    key: keyState.key,
    modelId: target.modelId,
    body,
    kind: 'chat',
  });

  const timeout = timeoutSignal(cfg.settings.requestTimeoutMs || 120000);
  const signal = combineSignals([timeout.signal, clientSignal]).signal;
  let upstream;
  try {
    upstream = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.payload),
      signal,
    });
  } catch (err) {
    timeout.clear();
    if (/abort/i.test(String(err.name || ''))) {
      return { ok: false, status: 504, kind: 'network', errorText: '请求上游超时' };
    }
    return { ok: false, status: 502, kind: 'network', errorText: `无法连接上游：${err.message}` };
  }

  if (!upstream.ok) {
    let text = '';
    try {
      text = await upstream.text();
    } catch (_e) {
      text = '';
    }
    timeout.clear();
    return {
      ok: false,
      status: upstream.status,
      kind: classifyError(upstream.status, text),
      errorText: text || `HTTP ${upstream.status}`,
      retryAfterMs: Number(upstream.headers.get('retry-after') || 0) * 1000,
    };
  }

  if (!stream) {
    let json = null;
    let text = '';
    try {
      text = await upstream.text();
      json = JSON.parse(text);
    } catch (_e) {
      timeout.clear();
      return {
        ok: false,
        status: 502,
        kind: 'server',
        errorText: `上游返回了无法解析的内容：${text.slice(0, 300)}`,
      };
    }
    timeout.clear();
    const norm = normalizeResponse(json, target, { providerType: provider.type });
    const usage = usageFrom(json) || { input: inputEstimate, output: estimateTokens(extractOutputText(norm)) };
    return { ok: true, status: 200, json: norm, usage };
  }

  // ---- 流式 ----
  return streamAttempt({
    upstream,
    provider,
    target,
    nodeRes,
    inputEstimate,
    timeout,
    keyState,
    release: () => ctx.pool.release(keyState),
  });
}

/**
 * 流式透传：边转发边解析用于统计 tokens。
 * 关键点——响应头延迟到「收到上游第一个字节」时才写出，
 * 这样首字节前失败（连不上/429/500）就能干净地换下一个渠道重试。
 */
async function streamAttempt(o) {
  const { upstream, provider, target, nodeRes, inputEstimate, timeout, release } = o;
  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  const anthropic = provider.type === 'anthropic';

  let headersSent = false;
  const sendHeaders = () => {
    if (headersSent || !nodeRes) return;
    nodeRes.writeHead(200, sseHeaders);
    if (typeof nodeRes.flushHeaders === 'function') nodeRes.flushHeaders();
    headersSent = true;
  };

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let outputText = '';
  let reportedUsage = null;
  let firstByte = false;
  let finished = false;
  const meta = {
    id: `chatcmpl-${Math.random().toString(36).slice(2, 10)}`,
    created: Math.floor(Date.now() / 1000),
    model: target.display,
  };

  // 客户端断开时立即取消上游读取，避免白跑 token / 占用密钥并发
  if (nodeRes && typeof nodeRes.on === 'function') {
    nodeRes.on('close', () => {
      if (finished) return;
      reader.cancel().catch(() => {});
    });
  }

  const done = (emitDone) => {
    if (finished) return;
    finished = true;
    try { reader.cancel().catch(() => {}); } catch (_e) { /* ignore */ }
    if (release) { try { release(); } catch (_e) { /* ignore */ } }
  };

  try {
    for (;;) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;
      firstByte = true;
      sendHeaders();

      if (!anthropic && nodeRes && !nodeRes.writableEnded) {
        nodeRes.write(Buffer.from(value));
      }

      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const parsed = parseSseLine(line);
        if (parsed && parsed.json) {
          const j = parsed.json;
          const u = usageFrom(j);
          if (u) reportedUsage = u;
          outputText += deltaText(j);
          if (anthropic) {
            const converted = anthropicEventToOpenAI(j, meta);
            if (converted && nodeRes && !nodeRes.writableEnded) {
              nodeRes.write(`data: ${JSON.stringify(converted)}\n\n`);
            }
          }
        }
        idx = buffer.indexOf('\n');
      }
    }

    if (nodeRes && !nodeRes.writableEnded) {
      sendHeaders();
      nodeRes.write('data: [DONE]\n\n');
      nodeRes.end();
    }
    timeout.clear();
    done(true);
  } catch (err) {
    timeout.clear();
    const aborted = /abort/i.test(String(err.name || err.message));
    if (!firstByte && !headersSent) {
      // 一个字节都没吐出去：安全返回失败，让上层换渠道
      done(false);
      return {
        ok: false,
        status: aborted ? 504 : 502,
        kind: aborted ? 'timeout' : 'network',
        errorText: `流式连接未能建立：${err.message}`,
      };
    }
    // 已经在吐内容了，只能如实收尾
    if (nodeRes && !nodeRes.writableEnded) {
      nodeRes.write(`data: ${JSON.stringify({ error: { message: `流式传输中断：${err.message}`, type: 'upstream_error' } })}\n\n`);
      nodeRes.write('data: [DONE]\n\n');
      nodeRes.end();
    }
    log.warn(`流式传输中断（已开始输出，无法转移）：${err.message}`);
    done(false);
  }

  const usage = reportedUsage || { input: inputEstimate, output: estimateTokens(outputText) };
  return { ok: true, status: 200, streamed: true, usage };
}

/** 内置模拟渠道：本地生成，支持流式 */
async function mockAttempt(o) {
  const { target, body, stream, nodeRes, inputEstimate } = o;
  const json = mockCompletion(body, target.display || target.modelId);
  const usage = {
    input: json.usage.prompt_tokens,
    output: json.usage.completion_tokens,
  };

  if (!stream) {
    await sleep(MOCK_LATENCY_MS);
    return { ok: true, status: 200, json, usage };
  }

  const meta = {
    id: json.id,
    created: json.created,
    model: target.display || target.modelId,
  };
  if (nodeRes) {
    nodeRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
  }
  const content = json.choices[0].message.content;
  const pieces = content.match(/[\s\S]{1,18}/g) || [content];
  for (const piece of pieces) {
    if (nodeRes && !nodeRes.writableEnded) {
      nodeRes.write(`data: ${JSON.stringify({
        id: meta.id,
        object: 'chat.completion.chunk',
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })}\n\n`);
    }
    await sleep(MOCK_CHUNK_DELAY_MS);
  }
  if (nodeRes && !nodeRes.writableEnded) {
    nodeRes.write(`data: ${JSON.stringify({
      id: meta.id,
      object: 'chat.completion.chunk',
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
    })}\n\n`);
    nodeRes.write('data: [DONE]\n\n');
    nodeRes.end();
  }
  return { ok: true, status: 200, streamed: true, usage };
}

/**
 * 非 chat 的简单透传（如 embeddings / 上游模型的列表探测）。
 */
async function passthrough(cfg, provider, key, { kind, body, modelId }) {
  const req = buildRequest({ provider, key, modelId, body, kind });
  const timeout = timeoutSignal(cfg.settings.requestTimeoutMs || 60000);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: JSON.stringify(req.payload),
      signal: timeout.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_e) {
      json = { raw: text };
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 502, json: { error: { message: err.message } } };
  } finally {
    timeout.clear();
  }
}

async function listUpstreamModels(cfg, provider, key) {
  const url = buildRequest({ provider, key, modelId: '', body: {}, kind: 'models' }).url;
  const timeout = timeoutSignal(20000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: (() => {
        const h = {};
        if (provider.type === 'anthropic') {
          if (key && key !== '__keyless__') h['x-api-key'] = key;
          h['anthropic-version'] = '2023-06-01';
        } else if (key && key !== '__keyless__') h.Authorization = `Bearer ${key}`;
        if (provider.id === 'openrouter') h['X-Title'] = 'Free Model Gateway';
        return h;
      })(),
      signal: timeout.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: redactSecrets(text.slice(0, 300)) };
    const json = JSON.parse(text);
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    return { ok: true, models: list };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    timeout.clear();
  }
}

module.exports = {
  execute,
  resolveTargets,
  autoTargets,
  usableTargets,
  listUpstreamModels,
  passthrough,
  MOCK_LATENCY_MS,
};
