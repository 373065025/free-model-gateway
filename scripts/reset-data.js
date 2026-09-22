'use strict';

/**
 * 清空统计与演示数据，回到全新状态。
 *   node scripts/reset-data.js            # 只清统计数据
 *   node scripts/reset-data.js --all      # 连请求日志、网关密钥一起重建
 */

const fs = require('fs');
const { loadConfig } = require('../src/config');
const { Stats } = require('../src/stats');

const all = process.argv.includes('--all');
const cfg = loadConfig();

const stats = new Stats({
  file: cfg.paths.usageFile,
  tzOffsetMinutes: cfg.settings.tzOffsetMinutes,
});
stats.reset();
console.log(`已清空统计数据：${cfg.paths.usageFile}`);

if (all) {
  for (const file of [cfg.paths.gatewayKeyFile]) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`已删除：${file}`);
    }
  }
  console.log('网关访问密钥将在下次启动时重新生成。');
}
