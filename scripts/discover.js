'use strict';

/**
 * 手动触发「免费模型发现」：按渠道拉取官方模型列表，过滤出免费档并落盘。
 *   node scripts/discover.js            # 全部渠道
 *   node scripts/discover.js groq gemini# 只探测指定渠道
 */

const { loadConfig } = require('../src/config');
const { discoverAll, discoverProvider } = require('../src/discover');

async function main() {
  const cfg = loadConfig();
  const wanted = process.argv.slice(2).map((s) => s.toLowerCase());
  const targets = wanted.length
    ? cfg.providers.filter((p) => wanted.includes(p.id.toLowerCase()) || wanted.includes(p.name.toLowerCase()))
    : null;

  console.log('\n=== 免费模型发现 ===\n');

  if (targets) {
    for (const provider of targets) {
      if (!provider.keyless && !provider.keys.length) {
        console.log(`  [跳过] ${provider.name}：未配置密钥`);
        continue;
      }
      const r = await discoverProvider(provider, { file: cfg.paths.discoveredFile });
      if (r.ok) {
        console.log(`  [完成] ${provider.name}：上游共 ${r.total} 个模型，筛选出 ${r.added} 个免费候选`);
        r.models.forEach((m) => console.log(`           · ${m}`));
      } else {
        console.log(`  [失败] ${provider.name}：${r.error}`);
      }
    }
  } else {
    const results = await discoverAll(cfg, {});
    if (!results.length) {
      console.log('  没有可探测的渠道：请先在 config/keys.json 或环境变量里配置至少一个平台密钥。\n');
    }
    for (const r of results) {
      if (r.ok) {
        console.log(`  [完成] ${r.name}：上游 ${r.total} 个模型 → 免费候选 ${r.added} 个`);
        (r.models || []).slice(0, 6).forEach((m) => console.log(`           · ${m}`));
      } else {
        console.log(`  [失败] ${r.name}：${r.error}`);
      }
    }
  }

  console.log('\n结果已写入 config/models.discovered.json，重启网关或调用 POST /admin/api/reload 后生效。\n');
}

main().catch((err) => {
  console.error('发现脚本异常：', err);
  process.exitCode = 1;
});
