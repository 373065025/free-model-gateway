'use strict';

/**
 * 协议适配层。
 *
 * 绝大多数免费平台都提供 OpenAI 兼容端点（openai 类型，直通）；
 * 少数平台用自有协议（如 anthropic），这里统一转成 OpenAI 形状，
 * 让「上游五花八门 / 下游只有一个入口」这件事成立。
 */

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

const OPENAI_TYPES = new Set(['openai']);
const SUPPORTED_TYPES = new Set(['openai', 'anthropic', 'mock']);

function assertSupported(provider) {
  if (!SUPPORTED_TYPES.has(provider.type)) {
    throw new Error(`渠道 ${provider.id} 使用了不支持的协议类型：${provider.type}`);
  }
}

function headersFor(provider, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.type === 'anthropic') {
    if (key && key !== '__keyless__') headers['x-api-key'] = key;
    headers['anthropic-version'] = provider.anthropicVersion || DEFAULT_ANTHROPIC_VERSION;
  } else if (key && key !== '__keyless__') {
    headers.Authorization = `Bearer ${key}`;
  }
  if (provider.headers && typeof provider.headers === 'object') {
    Object.assign(headers, provider.headers);
  }
  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost:8787';
    headers['X-Title'] = 'Free Model Gateway';
  }
  if (provider.id === 'github') {
    headers.Accept = 'application/vnd.github+json';
  }
  return headers;
}

function urlFor(provider, kind) {
  const base = provider.baseUrl;
  if (provider.type === 'anthropic') {
    return kind === 'chat' ? `${base}/messages` : `${base}/models`;
  }
  if (kind === 'chat') return `${base}/chat/completions`;
  if (kind === 'embeddings') return `${base}/embeddings`;
  return `${base}/models`;
}

/**
 * 构造发往上游的请求。
 * @returns {{url:string, headers:object, payload:object, method:string}}
 */
function buildRequest({ provider, key, modelId, body, kind = 'chat' }) {
  assertSupported(provider);
  const headers = headersFor(provider, key);

  if (provider.type === 'anthropic') {
    const systemParts = [];
    const messages = [];
    for (const m of body.messages || []) {
      if (m.role === 'system') {
        systemParts.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      } else {
        messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      }
    }
    const payload = {
      model: modelId,
      messages,
      max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
      stream: !!body.stream,
    };
    if (systemParts.length) payload.system = systemParts.join('\n\n');
    if (typeof body.temperature === 'number') payload.temperature = body.temperature;
    if (typeof body.top_p === 'number') payload.top_p = body.top_p;
    if (Array.isArray(body.stop)) payload.stop_sequences = body.stop;
    return { url: urlFor(provider, kind), headers, payload, method: 'POST' };
  }

  // 默认 OpenAI 兼容：替换模型 id，其余透传
  const payload = Object.assign({}, body, { model: modelId });
  delete payload.__gateway;
  if (payload.stream && provider.streamUsage !== false) {
    payload.stream_options = Object.assign({ include_usage: true }, payload.stream_options || {});
  }
  if (provider.type === 'mock') {
    payload.__mock = true;
  }
  return { url: urlFor(provider, kind), headers, payload, method: 'POST' };
}

/** 上游响应 → OpenAI 形状 */
function normalizeResponse(json, target, extra = {}) {
  if (!json || typeof json !== 'object') return json;
  const out = Object.assign({}, json);
  out.model = target.display || target.modelId;
  out.x_gateway = {
    provider: target.providerId,
    provider_name: target.providerName,
    upstream_model: target.modelId,
  };
  if (extra.providerType === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
    const reasoning = blocks.filter((b) => b && b.type === 'thinking').map((b) => b.thinking).join('');
    const msg = { role: 'assistant', content: text };
    if (reasoning) msg.reasoning_content = reasoning;
    out.object = 'chat.completion';
    out.id = json.id || `chatcmpl-${Date.now()}`;
    out.created = Math.floor(Date.now() / 1000);
    out.choices = [{
      index: 0,
      message: msg,
      finish_reason: json.stop_reason === 'max_tokens' ? 'length' : (json.stop_reason || 'stop'),
    }];
    out.usage = {
      prompt_tokens: (json.usage && json.usage.input_tokens) || 0,
      completion_tokens: (json.usage && json.usage.output_tokens) || 0,
      total_tokens: ((json.usage && (json.usage.input_tokens + json.usage.output_tokens)) || 0),
    };
  }
  if (!out.usage && !Array.isArray(out.data)) {
    out.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  return out;
}

/** 从上游响应里取 usage（不同平台字段名略有差异） */
function usageFrom(json) {
  if (!json) return null;
  const u = json.usage || json.usage_metadata || null;
  if (!u) return null;
  const input = num(u.prompt_tokens, u.input_tokens, u.promptTokenCount);
  const output = num(u.completion_tokens, u.output_tokens, u.candidatesTokenCount);
  if (input === null && output === null) return null;
  return { input: input || 0, output: output || 0 };
}

function num(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/** 解析一行 SSE，返回 {data} 或 null */
function parseSseLine(line) {
  if (!line) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  let payload = null;
  if (trimmed.startsWith('data:')) payload = trimmed.slice(5).trim();
  else if (trimmed.startsWith('{')) payload = trimmed;
  else return null;
  if (!payload || payload === '[DONE]') return { done: true };
  try {
    return { json: JSON.parse(payload) };
  } catch (_e) {
    return null;
  }
}

/** 从 SSE 增量块里抽文本（用于 token 估算与前端回显） */
function deltaText(json) {
  if (!json) return '';
  let out = '';
  const choice = json.choices && json.choices[0];
  if (choice) {
    const d = choice.delta || choice.message || {};
    if (typeof d.content === 'string') out += d.content;
    if (typeof d.reasoning_content === 'string') out += d.reasoning_content;
  }
  if (json.type === 'content_block_delta' && json.delta && typeof json.delta.text === 'string') out += json.delta.text;
  return out;
}

/** Anthropic 流事件 → OpenAI chunk（供 anthropic 渠道流式透传用） */
function anthropicEventToOpenAI(evt, meta) {
  if (!evt || typeof evt !== 'object') return null;
  const base = {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: meta.model,
  };
  if (evt.type === 'content_block_delta' && evt.delta) {
    const text = evt.delta.type === 'thinking_delta' ? '' : (evt.delta.text || '');
    if (!text) return null;
    return Object.assign({}, base, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  }
  if (evt.type === 'message_delta' && evt.delta) {
    return Object.assign({}, base, {
      choices: [{ index: 0, delta: {}, finish_reason: evt.delta.stop_reason === 'max_tokens' ? 'length' : 'stop' }],
      usage: evt.usage ? { prompt_tokens: 0, completion_tokens: evt.usage.output_tokens || 0 } : undefined,
    });
  }
  return null;
}

/** 生成本地模拟渠道的响应（无网/无密钥时也能跑通全链路） */
function mockCompletion(body, modelId) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.length ? messages[messages.length - 1] : null;
  const userText = last ? (typeof last.content === 'string' ? last.content : JSON.stringify(last.content)) : '';
  const head = `这是由内置模拟渠道（${modelId}）返回的占位回复。`;
  const body_text = [
    '它存在的意义是：在没有配置任何真实密钥、或者外网不可达的情况下，',
    '仍然能够验证整个网关的链路——路由、限流、故障转移、流式透传、用量统计、Dashboard 展示。',
    '',
    `本次请求共携带 ${messages.length} 条消息；你最后说的是：「${String(userText).slice(0, 120)}」。`,
    '',
    '要接入真实免费模型，只需把对应平台的密钥写进 config/keys.json 或环境变量，',
    '然后重启网关即可——路由会自动把流量切到真实渠道上。',
  ].join('\n');
  const content = `${head}\n${body_text}`;
  const promptTokens = Math.max(1, Math.round(content.length / 4.2));
  const completionTokens = Math.max(1, Math.round(content.length / 3.4));
  return {
    id: `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

module.exports = {
  OPENAI_TYPES,
  SUPPORTED_TYPES,
  assertSupported,
  buildRequest,
  normalizeResponse,
  usageFrom,
  parseSseLine,
  deltaText,
  anthropicEventToOpenAI,
  mockCompletion,
  urlFor,
};
