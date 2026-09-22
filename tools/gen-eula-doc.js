'use strict';

/**
 * 从 src/eula.js 生成仓库内的《用户协议与免责同意书》文档。
 *
 * 为什么要生成而不是手写：
 *   应用内弹窗的正文与仓库文档必须逐字一致，否则「你同意的到底是哪一版」就说不清了。
 *   统一以 src/eula.js 为唯一来源（single source of truth），本脚本负责导出。
 *
 *   node tools/gen-eula-doc.js
 *   node tools/gen-eula-doc.js --check   # 只校验，不写盘（CI 用）
 */

const fs = require('fs');
const path = require('path');

const eula = require('../src/eula');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'docs', '用户协议与免责同意书.md');

function render() {
  const text = eula.getFullText();
  const lines = [];

  lines.push('# ' + text.title);
  lines.push('');
  lines.push('> 版本 **v' + text.version + '** · 更新日期 ' + text.updatedAt);
  lines.push('>');
  lines.push('> ' + text.short);
  lines.push('');
  lines.push('本文件由 `tools/gen-eula-doc.js` 从 `src/eula.js` 自动导出，请勿手工修改；');
  lines.push('应用首次启动时会弹出同一份正文，用户确认后才会开放网关服务。');
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const sec of text.sections) {
    lines.push('## ' + sec.title);
    lines.push('');
    for (const p of sec.body) {
      lines.push(p);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('*本同意书不构成法律意见。正式对外分发前建议由专业人士复核，并按所在地法律调整。*');
  lines.push('');
  return lines.join('\n');
}

function main() {
  const content = render();
  const checkOnly = process.argv.includes('--check');
  const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf-8') : null;

  if (checkOnly) {
    if (existing === content) {
      console.log('  PASS  docs/用户协议与免责同意书.md 与 src/eula.js 正文一致');
      return;
    }
    console.error('  FAIL  文档与 src/eula.js 不一致，请运行：node tools/gen-eula-doc.js');
    process.exitCode = 1;
    return;
  }

  if (existing === content) {
    console.log('  文档已是最新，无需重写。');
    return;
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, content, 'utf-8');
  console.log(`  已生成 ${path.relative(ROOT, TARGET)}（v${eula.EULA_VERSION}，${eula.EULA_SECTIONS.length} 个章节）`);
}

main();
