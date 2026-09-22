'use strict';

/**
 * 免费模型自动发现。
 *
 * 免费模型清单变化很快（下架/改名/转收费），所以不能让 providers.json 写死。
 * 这里按渠道去拉官方 /models 列表，用渠道自己的「免费特征」过滤后落盘到
 * config/models.discovered.json，网关启动时自动合并进模型注册表。
 */

const { listUpstreamModels } = require('./upstream');
const { writeJsonAtomic, readJson, logger } = require('./util');

const log = logger('discover');

const FREE_HINTS = [
  /:free$/i,
  /free/i,
  /-flash$|-flash-/i,
  /instant/i,
  /oss/i,
  /distill/i,
  /nano|mini|tiny|small|lite/i,
];

const DEFAULT_EXCLUDE = [
  /embed|rerank|embedding/i,
  /whisper|tts|speech|audio|voice/i,
  /image|vision-encoder|diffusion|flux|sd-|stable-diffusion/i,
  /video|wan-|cogvideo/i,
  /moderation|guard/i,
];

function looksFree(id, provider) {
  const filter = provider.freeFilter;
  if (filter && String(id).toLowerCase().includes(String(filter).toLowerCase())) return true;
  return FREE_HINTS.some((re) => re.test(id));
}

function looksExcluded(id) {
  return DEFAULT_EXCLUDE.some((re) => re.test(id));
}

/**
 * 对单个渠道执行发现。
 * @returns {{providerId:string,name:string,ok:boolean,added:number,total:number,error?:string}}
 */
async function discoverProvider(provider, opts = {}) {
  const all = provider.models.map((m) => m.id);
  const manual = new Set(all);
  const key = provider.keys[0];
  const res = await listUpstreamModels({}, provider, key);
  if (!res.ok) {
    return { providerId: provider.id, name: provider.name, ok: false, added: 0, total: 0, error: res.error || `HTTP ${res.status}` };
  }
  const found = [];
  for (const item of res.models) {
    const id = item && (item.id || item.name || item.model);
    if (!id || typeof id !== 'string') continue;
    if (manual.has(id)) continue;
    if (looksExcluded(id)) continue;
    if (!looksFree(id, provider)) continue;
    const caps = ['chat'];
    const modalities = item.architecture && item.architecture.modality;
    if (typeof modalities === 'string' && /image/.test(modalities)) caps.push('vision');
    if (item.context_length && item.context_length >= 100000) caps.push('long');
    found.push({
      id,
      name: item.name || id,
      ctx: Number(item.context_length || item.context_window || 0) || 0,
      caps,
      freeFilter: provider.freeFilter || '',
    });
  }
  found.sort((a, b) => b.ctx - a.ctx);
  const limited = found.slice(0, opts.maxPerProvider || 40);

  if (!opts.dryRun) {
    const store = readJson(opts.file, {}) || {};
    store[provider.id] = limited;
    store.__updatedAt = new Date().toISOString();
    writeJsonAtomic(opts.file, store);
  }

  return {
    providerId: provider.id,
    name: provider.name,
    ok: true,
    added: limited.length,
    total: res.models.length,
    models: limited.slice(0, 12).map((m) => m.id),
  };
}

/** 对所有配了密钥、且开启了 discover 的渠道执行发现 */
async function discoverAll(cfg, opts = {}) {
  const targets = cfg.providers.filter(
    (p) => p.enabled && p.discover && (p.keyless || p.keys.length) && p.baseUrl && !p.baseUrl.startsWith('mock:')
  );
  const results = [];
  for (const provider of targets) {
    try {
      const r = await discoverProvider(provider, Object.assign({ file: cfg.paths.discoveredFile }, opts));
      results.push(r);
      log.info(`${provider.name}: 发现 ${r.added}/${r.total} 个候选模型`);
    } catch (err) {
      results.push({ providerId: provider.id, name: provider.name, ok: false, added: 0, total: 0, error: err.message });
      log.warn(`${provider.name} 发现失败: ${err.message}`);
    }
  }
  return results;
}

module.exports = { discoverAll, discoverProvider, looksFree };
