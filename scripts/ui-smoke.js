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

/* 只有本机回环访问才会被服务端下发管理令牌；远程访问下 bootstrap 会 403，
   此时不该往 localStorage 里塞假令牌（会直接把所有接口打成 401）。 */
const IS_LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(BASE);

/* 模拟「重装过 / 换过数据目录」的浏览器：localStorage 里还留着一把早已失效的令牌。
   网关密钥是重新生成的，前端必须自己去服务端换一把，而不是拿旧令牌一路 401。 */
const STALE_TOKEN = 'gw-stale-token-from-a-previous-install';

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

/**
 * 趋势图、排行榜、峰值日在「没有任何流量」时会（正确地）渲染成空状态，
 * 而 CI / 全新安装的机器恰好就是这种情况，于是那些断言会误报。
 * 这里先用本机回环拿管理令牌；只在统计确实为空时，灌少量真实的内置模拟流量，
 * 让「有数据」的富渲染路径也被覆盖到。已有真实数据时绝不打扰。
 */
async function ensureSampleData(doc) {
  let key = '';
  try {
    const res = await fetch(`${BASE}/admin/api/bootstrap`);
    if (res.ok) key = ((await res.json()) || {}).token || '';
  } catch (_e) { /* 远程访问不允许自动下发令牌，那就跳过采样 */ }
  if (!key) return false;

  let empty = false;
  try {
    const ov = await (await fetch(`${BASE}/admin/api/overview?token=${encodeURIComponent(key)}`)).json();
    empty = !ov || !ov.stats || !ov.stats.totals || ov.stats.totals.calls === 0;
  } catch (_e) { return false; }
  if (!empty) return false;

  for (let i = 0; i < 6; i += 1) {
    try {
      await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'mock', messages: [{ role: 'user', content: `ui-smoke 采样 ${i + 1}` }] }),
      });
    } catch (_e) { /* 单条失败不影响整体 */ }
  }
  const btn = doc.getElementById('refreshBtn');
  if (btn) btn.click();
  await sleep(1500);
  return true;
}

/* 取本机网关的管理令牌。只有「网关所在机器自己」访问才会下发，
   跨局域网会 403 —— 返回空串时调用方应跳过相关断言。 */
async function getAdminToken() {
  try {
    const res = await fetch(`${BASE}/admin/api/bootstrap`);
    if (!res.ok) return '';
    const j = await res.json();
    return (j && j.token) || '';
  } catch (_e) { return ''; }
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
      // 必须赶在 public/app.js 执行之前把失效令牌写进去，才能复现真实用户的处境
      if (IS_LOOPBACK) {
        try { window.localStorage.setItem('fmg.adminToken', STALE_TOKEN); } catch (_e) { /* 忽略 */ }
      }
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

  // app.js 由 jsdom 通过网络加载。首次运行时同意书会先弹出，此时大屏数据尚未加载；
  // 所以「就绪」有两种可能：同意书弹窗出现，或大屏数据已渲染。
  const eulaModal = doc.getElementById('eulaModal');
  const eulaVisible = () => !!eulaModal && !eulaModal.classList.contains('hidden');
  const ready = await waitFor(() => eulaVisible() || q('#leaderboard .lb-row').length > 0, 15000);
  if (!ready) await sleep(2000);

  // ---- 回归：陈旧令牌必须被服务端的新令牌自动换掉 ----
  // 这是「重装后打开大屏，同意书只显示『管理令牌无效』」那个线上问题的看门人。
  if (IS_LOOPBACK) {
    const stored = window.localStorage.getItem('fmg.adminToken');
    check('残留的陈旧管理令牌已被服务端新令牌自动覆盖',
      !!stored && stored !== STALE_TOKEN,
      stored ? `localStorage 现为 ${String(stored).slice(0, 14)}…` : 'localStorage 为空');
  }

  // ---- 首次使用：《用户许可与免责同意书》门禁 ----
  const eulaFirstRun = eulaVisible();
  if (eulaFirstRun) {
    check('未同意时自动弹出同意书', true, '弹窗已显示');
    check('同意书标题正确', txt('eulaTitle').includes('用户许可与免责同意书'), txt('eulaTitle'));
    check('同意书版本号已回填', /^v\d/.test(txt('eulaVersionBadge')), txt('eulaVersionBadge'));

    const secs = q('#eulaBody .eula-sec');
    check('同意书章节已全部渲染', secs.length >= 10, `${secs.length} 个章节`);
    check('同意书正文非空', txt('eulaBody').length > 800, `${txt('eulaBody').length} 字符`);

    const agree = doc.getElementById('eulaAgree');
    const acceptBtn = doc.getElementById('eulaAcceptBtn');
    check('未勾选时「同意」按钮不可点', acceptBtn.disabled === true);
    check('未同意时关闭按钮隐藏（弹窗不可跳过）',
      doc.getElementById('eulaCloseBtn').classList.contains('hidden'));
    check('未同意时大屏数据为空（门禁生效）',
      txt('statCalls') === '--' && q('#leaderboard .lb-row').length === 0,
      `累计调用占位=${JSON.stringify(txt('statCalls'))}`);

    agree.checked = true;
    agree.dispatchEvent(new window.Event('change', { bubbles: true }));
    const armed = await waitFor(() => acceptBtn.disabled === false, 4000);
    check('勾选后「同意」按钮变为可点', armed);

    if (armed) {
      acceptBtn.click();
      // 零流量时排行榜本来就是空的，所以用「指标卡不再是占位符」作为门禁解除的判据
      const unlocked = await waitFor(
        () => txt('statCalls') !== '--' && txt('statCalls').length > 0, 15000);
      check('点击同意后门禁解除并加载出大屏数据', unlocked, `累计调用 ${txt('statCalls')}`);
      check('同意后同意书弹窗自动关闭', !eulaVisible());
    }
  } else {
    check('已处于已同意状态（跳过首次弹窗用例）', true, '同意记录已存在');
    check('同意书弹窗默认隐藏', !eulaVisible());
  }

  // 保证「有数据才渲染」的那些断言（趋势线 / 排行榜 / 峰值日）在全新环境里也成立
  if (await ensureSampleData(doc)) {
    console.log('  （本机统计为空，已灌入 6 条内置模拟流量用于渲染校验）');
    const ok = await waitFor(() => q('#leaderboard .lb-row').length > 0, 8000);
    if (!ok) console.log('  （采样数据未及时反映到页面）');
  }

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

  // 主题切换：浅色 / 深色 / 跟随系统
  const rootEl = doc.documentElement;
  const themeBtns = q('#themeSeg .seg-btn');
  check('主题切换控件有三个选项', themeBtns.length === 3, `${themeBtns.length} 个`);
  check('初始主题已写入 data-theme',
    ['dark', 'light'].indexOf(rootEl.getAttribute('data-theme')) >= 0,
    `data-theme=${rootEl.getAttribute('data-theme')} / data-pref=${rootEl.getAttribute('data-pref')}`);

  const lightBtn = doc.querySelector('#themeSeg .seg-btn[data-theme="light"]');
  const darkBtn = doc.querySelector('#themeSeg .seg-btn[data-theme="dark"]');
  const sysBtn = doc.querySelector('#themeSeg .seg-btn[data-theme="system"]');
  if (lightBtn && darkBtn && sysBtn) {
    lightBtn.click();
    await sleep(180);
    const lightOk = rootEl.getAttribute('data-theme') === 'light'
      && lightBtn.classList.contains('active')
      && window.localStorage.getItem('fm-theme') === 'light';
    const lightLine = doc.getElementById('trendChart').querySelector('path[stroke]');

    darkBtn.click();
    await sleep(180);
    const darkOk = rootEl.getAttribute('data-theme') === 'dark'
      && darkBtn.classList.contains('active')
      && window.localStorage.getItem('fm-theme') === 'dark';
    const darkLine = doc.getElementById('trendChart').querySelector('path[stroke]');

    check('点击「浅色」切到浅色主题并落盘', lightOk, `data-theme=${rootEl.getAttribute('data-theme')}`);
    check('点击「深色」切到深色主题并落盘', darkOk, `data-theme=${rootEl.getAttribute('data-theme')}`);
    check('切换主题后趋势线按新主题重绘',
      !!lightLine && !!darkLine && (lightLine.getAttribute('stroke') || '').length > 0,
      `浅色 ${lightLine && lightLine.getAttribute('stroke')} → 深色 ${darkLine && darkLine.getAttribute('stroke')}`);

    sysBtn.click();
    await sleep(180);
    check('点击「自动」恢复跟随系统',
      rootEl.getAttribute('data-pref') === 'system' && sysBtn.classList.contains('active'),
      `data-pref=${rootEl.getAttribute('data-pref')}`);
  }

  // 设置浮层（管理令牌）
  const gear = doc.getElementById('settingsBtn');
  const panel = doc.getElementById('settingsPanel');
  if (gear && panel) {
    const startHidden = panel.classList.contains('hidden');
    gear.click();
    await sleep(100);
    const opened = !panel.classList.contains('hidden');
    doc.body.click();
    await sleep(100);
    const closed = panel.classList.contains('hidden');
    check('齿轮按钮可开合设置浮层', startHidden && opened && closed,
      `初始隐藏=${startHidden} 点击后显示=${opened} 点外部后收起=${closed}`);
  }

  check('更新源默认指向官方仓库',
    txt('updateSource').indexOf('373065025/free-model-gateway') >= 0, txt('updateSource'));

  // 每日推送面板
  const notifyTime = doc.getElementById('notifyTime');
  const notifyToken = doc.getElementById('notifyToken');
  if (notifyTime && notifyToken) {
    check('每日推送面板已渲染（开关 / 时间 / token / 渠道 / 跳过空流量）',
      !!doc.getElementById('notifyEnabled') && !!doc.getElementById('notifyChannel')
      && !!doc.getElementById('notifySkipIdle') && !!doc.getElementById('notifySaveBtn'));
    check('推送时间已从接口回填为 HH:MM', /^\d{2}:\d{2}$/.test(notifyTime.value), notifyTime.value);
    check('推送摘要已回填',
      txt('notifySummary').includes('每天') && txt('notifySummary').includes('推送'), txt('notifySummary'));
    check('token 输入框不回显明文',
      notifyToken.type === 'password' && notifyToken.value === '', `type=${notifyToken.type}`);

    doc.getElementById('notifyPreviewBtn').click();
    const shown = await waitFor(
      () => !doc.getElementById('notifyPreview').classList.contains('hidden'), 8000);
    const pv = doc.getElementById('notifyPreview');
    check('点击「预览日报」生成推送预览', shown && pv.innerHTML.length > 200, `${pv.innerHTML.length} 字符`);
    check('预览内容为用量日报', pv.innerHTML.includes('用量日报'), '');
  }

  // 页脚「用户协议」只读回看
  const openBtn = doc.getElementById('eulaOpenBtn');
  if (openBtn) {
    check('页脚提供用户协议入口', true, txt('eulaOpenBtn'));
    openBtn.click();
    const readonlyShown = await waitFor(
      () => eulaVisible() && !doc.getElementById('eulaReadFoot').classList.contains('hidden'), 6000);
    check('已同意时可只读回看同意书',
      readonlyShown && !doc.getElementById('eulaCloseBtn').classList.contains('hidden'),
      `弹窗可见=${eulaVisible()}`);
    doc.getElementById('eulaCloseBtn2').click();
    await sleep(150);
    check('只读回看可正常关闭', !eulaVisible());
  }

  // ---- 跨局域网访问：`?token=` 免手工输入 ----
  // 局域网访问时服务端不下发令牌，`?token=` 是唯一的零配置路径；
  // 顺带断言令牌会被立刻从地址栏抹掉（不留在浏览历史、书签与随手截图里）。
  if (IS_LOOPBACK) {
    const key = await getAdminToken();
    if (!key) {
      check('取到管理令牌用于 ?token= 校验', false, 'bootstrap 未返回令牌');
    } else {
      const scriptErrors2 = [];
      const vc2 = new VirtualConsole();
      vc2.on('jsdomError', (e) => scriptErrors2.push(e.message));
      const dom2 = new JSDOM(html, {
        url: `${BASE}/?token=${encodeURIComponent(key)}`,
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true,
        virtualConsole: vc2,
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
        },
      });
      const d2 = dom2.window.document;
      const calls2 = () => (d2.getElementById('statCalls') || {}).textContent || '';
      const ok2 = await waitFor(() => calls2() && calls2() !== '--', 15000);
      check('带 ?token= 打开即可直接取到数据（无需手工输入令牌）', !!ok2, `累计调用 ${calls2()}`);
      const search = String(dom2.window.location.search || '');
      check('令牌已从地址栏抹掉（不留在历史 / 书签 / 截图里）',
        !search.includes('token'), `地址栏 query=${JSON.stringify(search)}`);
      check('?token= 打开无脚本错误', scriptErrors2.length === 0,
        scriptErrors2.slice(0, 2).join(' | ') || '无错误');
      dom2.window.close();
    }
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
