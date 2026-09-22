'use strict';

/**
 * Dashboard 渲染冒烟测试：在真实 DOM（jsdom）里跑一遍 public/app.js，
 * 断言每个区块确实被渲染出来了，并捕获任何脚本运行时错误。
 *
 * 比截图可靠：截图只能证明首屏，这里能证明排行榜 / 渠道 / 模型 / 日志 / 密钥 / 曲线全部渲染成功。
 *
 *   node scripts/ui-smoke.js                 # 默认打 http://127.0.0.1:8787
 *   UI_SMOKE_BASE=http://127.0.0.1:9000 node scripts/ui-smoke.js
 */

const path = require('path');

const BASE = process.env.UI_SMOKE_BASE || 'http://127.0.0.1:8787';

let JSDOM = null;
let VirtualConsole = null;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (_e) {
  const ws = path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'jsdom');
  ({ JSDOM, VirtualConsole } = require(ws));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function waitFor(fn, timeoutMs = 12000, step = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fn()) return true;
    } catch (_e) { /* 继续等 */ }
    await sleep(step);
  }
  return false;
}

async function main() {
  console.log('\n=== Dashboard 渲染冒烟测试 ===\n');
  console.log(`目标：${BASE}\n`);

  let html;
  try {
    const res = await fetch(`${BASE}/`);
    html = await res.text();
  } catch (err) {
    console.error(`  无法访问 ${BASE}：${err.message}\n  请先启动网关：node src/index.js\n`);
    process.exitCode = 1;
    return;
  }

  const scriptErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => scriptErrors.push(`jsdomError: ${e.message}`));
  vc.on('error', (...args) => scriptErrors.push(`console.error: ${args.join(' ')}`));

  const dom = new JSDOM(html, {
    url: `${BASE}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        return fetch(new URL(url, `${BASE}/`).toString(), init);
      };
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      if (!window.navigator.clipboard) {
        Object.defineProperty(window.navigator, 'clipboard', {
          value: { writeText: async () => {} },
          configurable: true,
        });
      }
    },
  });

  const { window } = dom;
  const doc = window.document;
  const q = (sel) => doc.querySelectorAll(sel);
  const txt = (id) => (doc.getElementById(id) || {}).textContent || '';

  // app.js 由 jsdom 通过网络加载，等它就绪并跑完首次 render
  const ready = await waitFor(() => q('#leaderboard .lb-row').length > 0, 15000);
  if (!ready) await sleep(2000);

  check('页面标题正确', doc.title.includes('免费模型聚合网关'), doc.title);
  check('外部脚本无运行时错误', scriptErrors.length === 0, scriptErrors.slice(0, 3).join(' | ') || '无错误');

  // 顶部指标
  const calls = txt('statCalls');
  check('累计调用卡片已填充', /\d/.test(calls) && !calls.includes('--'), calls);
  check('输入消耗卡片已填充', txt('statInput') !== '--' && txt('statInput').length > 0, txt('statInput'));
  check('输出 Tokens 卡片已填充', txt('statOutput') !== '--', txt('statOutput'));
  check('连续服务卡片已填充', /天/.test(txt('statStreak')), txt('statStreak'));

  // 趋势图
  const chart = doc.getElementById('trendChart');
  const linePath = chart && chart.querySelector('path[stroke]');
  const areaPath = chart && chart.querySelector('path[fill^="url"]');
  check('趋势折线已绘制', !!linePath && linePath.getAttribute('d').length > 40,
    linePath ? `${linePath.getAttribute('d').slice(0, 40)}…` : '未找到');
  check('趋势面积渐变已绘制', !!areaPath);
  check('趋势图 Y 轴刻度已绘制', q('#trendChart text').length >= 5, `${q('#trendChart text').length} 个文本节点`);
  check('图表起始/结束日期已填充', txt('chartFrom') !== '--' && txt('chartTo') !== '--', `${txt('chartFrom')} → ${txt('chartTo')}`);

  // 切换指标后仍能重绘
  const segBtns = q('#chartSeg .seg-btn');
  if (segBtns.length > 1) {
    segBtns[1].click();
    await sleep(300);
    const redrawn = doc.getElementById('trendChart').querySelector('path[stroke]');
    check('切换图表指标后可正常重绘', !!redrawn && redrawn.getAttribute('d').length > 40);
    segBtns[0].click();
    await sleep(200);
  }

  // 排行榜与峰值
  check('模型 Token 排行榜已渲染', q('#leaderboard .lb-row').length > 0, `${q('#leaderboard .lb-row').length} 行`);
  check('排行榜占比条已渲染', q('#leaderboard .lb-bar i').length > 0, `${q('#leaderboard .lb-bar i').length} 条`);
  check('峰值日已填充', txt('peakDay') !== '--', txt('peakDay'));

  // 接入信息
  check('API Base URL 已填充', /^http/.test(txt('baseUrl')), txt('baseUrl'));
  check('客户端密钥已填充', txt('clientKey').length > 3 && !txt('clientKey').startsWith('('), txt('clientKey').slice(0, 14));
  check('接入代码片段已生成', txt('snippetBox').length > 120, `${txt('snippetBox').length} 字符`);

  const tabs = q('#snippetTabs .tab');
  if (tabs.length >= 4) {
    tabs[1].click();
    await sleep(150);
    const py = txt('snippetBox');
    tabs[3].click();
    await sleep(150);
    const cli = txt('snippetBox');
    check('切换代码片段标签有效', py.includes('OpenAI') && cli.includes('Base URL'), `Python ${py.length} 字符 / 客户端 ${cli.length} 字符`);
  }

  // 自测下拉
  check('在线自测的模型下拉已填充', q('#testModel option').length > 5, `${q('#testModel option').length} 个选项`);

  // 渠道 / 模型 / 密钥 / 日志
  const provs = q('#providerList .prov');
  check('渠道健康卡片已渲染', provs.length > 0, `${provs.length} 个渠道`);
  check('渠道状态徽章已渲染', q('#providerList .pill').length > 0, `${q('#providerList .pill').length} 个徽章`);
  check('渠道汇总文案已填充', txt('providerSummary').includes('启用'), txt('providerSummary'));

  const models = q('#modelList .model');
  check('可用模型清单已渲染', models.length > 0, `${models.length} 个模型`);
  check('模型清单汇总已填充', txt('modelSummary').includes('模型'), txt('modelSummary'));

  check('密钥池区块已渲染', q('#keyList .key-item').length > 0 || txt('keyList').includes('还没有任何密钥'),
    txt('keyList').includes('还没有任何密钥') ? '提示未配密钥（正常）' : `${q('#keyList .key-item').length} 张卡片`);

  const logRows = q('#logBody tr');
  check('请求日志已渲染', logRows.length > 0, `${logRows.length} 行`);
  check('页脚统计已填充', txt('footStart').includes('起计'), txt('footStart'));

  // 模型筛选
  const filter = doc.getElementById('modelFilter');
  if (filter && models.length > 1) {
    const before = q('#modelList .model').length;
    filter.value = 'gemini';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    await sleep(200);
    const after = q('#modelList .model').length;
    check('模型清单筛选可用', after <= before && after > 0, `${before} → ${after}`);
    filter.value = '';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  check('整个渲染过程无脚本错误', scriptErrors.length === 0, scriptErrors.slice(0, 3).join(' | ') || '无错误');

  dom.window.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
  if (failed.length) {
    console.log('\n未通过项：');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exitCode = 1;
  } else {
    console.log('\n大屏所有区块渲染正常。\n');
  }
}

main().catch((err) => {
  console.error('冒烟测试异常：', err);
  process.exitCode = 1;
});
