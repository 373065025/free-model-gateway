'use strict';

/* 免费模型聚合网关 · 监控大屏脚本（零依赖原生实现） */

const TOKEN_KEY = 'fmg.adminToken';
const THEME_KEY = 'fm-theme';
const THEMES = ['system', 'light', 'dark'];
const METRIC_LABEL = { total: '总 Tokens', input: '输入 Tokens', output: '输出 Tokens', calls: '调用次数' };

/* localStorage 在隐私模式 / 沙箱下可能抛错，统一兜底 */
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null || v === undefined ? fallback : v;
  } catch (_e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_e) { /* 忽略 */ }
}

/**
 * 支持用 `?token=<管理令牌>`（或 `#token=…`）打开大屏。
 * 局域网 / 远程访问时服务端**故意不下发**令牌（安全设计），用户只能手填或走 URL，
 * 而后端报错里一直引导的就是这种写法——前端此前没实现，导致远程访问无从下手。
 * 读到后立刻把令牌从地址栏抹掉，免得留在浏览历史、书签和随手截图里。
 */
function takeTokenFromUrl() {
  let token = '';
  let clean = '';
  try {
    const qs = new URLSearchParams(location.search || '');
    token = String(qs.get('token') || qs.get('admin_token') || '').trim();
    if (!token && location.hash) {
      const hs = new URLSearchParams(String(location.hash).replace(/^#/, ''));
      token = String(hs.get('token') || '').trim();
    }
    if (!token) return '';
    qs.delete('token');
    qs.delete('admin_token');
    const rest = qs.toString();
    clean = location.pathname + (rest ? `?${rest}` : '') + (String(location.hash).includes('token') ? '' : (location.hash || ''));
    if (window.history && history.replaceState) history.replaceState(null, '', clean);
  } catch (_e) { /* 地址栏不受控（如内嵌 webview）时忽略 */ }
  return token;
}

const URL_TOKEN = takeTokenFromUrl();
if (URL_TOKEN) lsSet(TOKEN_KEY, URL_TOKEN);

const state = {
  token: URL_TOKEN || lsGet(TOKEN_KEY, ''),
  theme: lsGet(THEME_KEY, 'system'),
  data: null,
  metric: 'total',
  snippet: 'curl',
  modelFilter: '',
  models: [],
  updateCfg: null,
  eula: null,
  notify: null,
  timer: null,
};

const $ = (id) => document.getElementById(id);

function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtCn(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return fmtInt(v);
}

function fmtMs(ms) {
  const v = Number(ms) || 0;
  if (v < 1000) return `${Math.round(v)} ms`;
  return `${(v / 1000).toFixed(2)} s`;
}

function fmtPct(x) {
  const v = Number(x) || 0;
  return `${(v * 100).toFixed(v >= 0.1 ? 1 : 2)}%`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* --------------------------------------------------------------- 主题 */
/* 三态：system（跟随系统）/ light / dark。解析结果写进 <html data-theme>。 */

function sysPrefersDark() {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (_e) { return false; }
}

function currentThemePref() {
  const t = state.theme;
  return THEMES.indexOf(t) >= 0 ? t : 'system';
}

function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return sysPrefersDark() ? 'dark' : 'light';
}

/** 把当前主题写进 DOM；图表颜色取自 CSS 变量，故重绘交给调用方决定 */
function applyTheme() {
  const pref = currentThemePref();
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveTheme(pref));
  root.setAttribute('data-pref', pref);
}

function renderTheme() {
  const pref = currentThemePref();
  const seg = $('themeSeg');
  if (!seg) return;
  seg.querySelectorAll('.seg-btn').forEach((b) => {
    const on = b.getAttribute('data-theme') === pref;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

let sysThemeHooked = false;
function watchSystemTheme() {
  if (sysThemeHooked || !window.matchMedia) return;
  let mq;
  try { mq = window.matchMedia('(prefers-color-scheme: dark)'); } catch (_e) { return; }
  const handler = () => { if (currentThemePref() === 'system') setTheme('system', false); };
  try {
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
    sysThemeHooked = true;
  } catch (_e) { /* 不支持就算了，跟随系统退化为固定值 */ }
}

function setTheme(pref, persist = true) {
  state.theme = THEMES.indexOf(pref) >= 0 ? pref : 'system';
  if (persist) lsSet(THEME_KEY, state.theme);
  applyTheme();
  renderTheme();
  if (state.data) renderChart();
}

/** 读取 CSS 自定义属性的当前计算值（图表需要跟随主题换色） */
function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch (_e) { return fallback; }
}


async function api(path, opts = {}) {
  return requestApi(path, opts, true);
}

/**
 * 真正发请求的地方。
 * @param allowHeal 收到 401 时是否允许「换一把令牌再试一次」（只重试一次，避免死循环）
 */
async function requestApi(path, opts, allowHeal) {
  const url = new URL(path, location.origin);
  const sentToken = state.token;
  if (sentToken) url.searchParams.set('token', sentToken);
  const res = await fetch(url.toString(), Object.assign({
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
  }, opts));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { json = { raw: text }; }
  if (!res.ok) {
    // 缓存的令牌可能已经失效（重装、换了数据目录、清了配置后网关密钥会重新生成）。
    // 本机回环下向服务端重新要一把再重试一次，别让用户被一个陈旧令牌卡死；
    // 换不到（远程访问不下发令牌）就清掉，让页面提示去手工填。
    if (allowHeal && res.status === 401 && sentToken) {
      const fresh = await refreshToken();
      if (fresh && fresh !== sentToken) return requestApi(path, opts, false);
      state.token = '';
      lsSet(TOKEN_KEY, '');
    }
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.code = (json && json.error && json.error.code) || '';
    // 未同意《用户许可与免责同意书》时，任何被门禁拦截的请求都直接把同意书弹出来
    if (err.code === 'eula_required') showEulaModal();
    throw err;
  }
  return json;
}

function showAlert(msg) {
  const box = $('alertBox');
  if (!msg) { box.classList.add('hidden'); return; }
  box.textContent = msg;
  box.classList.remove('hidden');
}

/* ------------------------------------------------------------------ 加载 */
/**
 * 向服务端要一把管理令牌：仅本机回环访问会下发（远程访问 403）。
 * 失败时**不要**清空已有令牌 —— 那可能是用户手填的。
 * 成功后以服务端返回的为准：重装 / 换数据目录后网关密钥会重新生成，
 * localStorage 里缓存的旧令牌必须被覆盖，否则整个大屏都会 401。
 */
async function refreshToken() {
  try {
    const res = await fetch('/admin/api/bootstrap', { cache: 'no-store' });
    if (!res.ok) return '';
    const json = await res.json();
    const token = (json && json.token) || '';
    if (!token) return '';
    state.token = token;
    lsSet(TOKEN_KEY, token);
    const input = $('tokenInput');
    if (input) input.value = token;
    return token;
  } catch (_e) {
    return '';
  }
}

async function bootstrapToken() {
  await refreshToken();
}

async function load() {
  try {
    const data = await api('/admin/api/overview');
    state.data = data;
    showAlert('');
    render();
  } catch (err) {
    if (err.status === 401) {
      showAlert('需要管理令牌才能查看数据。最省事是用 http://<网关地址>:8790/?token=<管理令牌> 打开本页；也可以点右上角齿轮图标手工填入。令牌在 NAS 数据目录的 gateway-key.txt 里，也打印在启动日志中。从本机 127.0.0.1 访问会自动填充。');
      const panel = $('settingsPanel');
      if (panel) panel.classList.remove('hidden');
    } else if (err.code === 'eula_required') {
      // 同意书弹窗已由 api() 自动触发，这里不再叠加错误提示
    } else {
      showAlert(`加载失败：${err.message}`);
    }
  }
}

function render() {
  const d = state.data;
  if (!d) return;
  applyTheme();
  renderTheme();
  $('liveBadge').classList.remove('hidden');
  $('demoBadge').classList.toggle('hidden', !(d.stats.meta && d.stats.meta.demo));
  renderStats(d);
  renderChart();
  renderLeaderboard(d);
  renderGateway(d);
  renderProviders(d);
  renderModels();
  renderKeys(d);
  renderUpdate(d);
  renderLogs(d);
  renderFooter(d);
}

/* ------------------------------------------------------------- 指标卡片 */
function renderStats(d) {
  const s = d.stats;
  $('statCalls').textContent = fmtInt(s.totals.calls);
  $('statCallsSub').textContent = `成功 ${fmtInt(s.totals.success)} · 失败 ${fmtInt(s.totals.failed)} · 重试 ${fmtInt(s.totals.retries)}`;

  $('statInput').textContent = fmtCn(s.totals.inputTokens);
  $('statInputSub').textContent = `今日 ${fmtCn(s.today.input)} · 精确值 ${fmtInt(s.totals.inputTokens)}`;

  $('statOutput').textContent = fmtCn(s.totals.outputTokens);
  $('statOutputSub').textContent = `成功率 ${fmtPct(s.totals.successRate)} · 平均延迟 ${fmtMs(s.totals.avgLatencyMs)}`;

  const days = Math.max(1, s.meta.activeDays || 1);
  $('statStreak').textContent = `${s.meta.uptimeDays} 天`;
  $('statStreakSub').textContent = `活跃 ${s.meta.activeDays} 天 · 日均 ${fmtCn(s.totals.totalTokens / days)} Tokens`;
}

/* ----------------------------------------------------------------- 图表 */
function metricValue(row) {
  if (state.metric === 'calls') return row.calls;
  return row[state.metric] || 0;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

let chartObserver = null;

function renderChart() {
  const d = state.data;
  if (!d) return;
  const svg = $('trendChart');
  const wrap = $('chartWrap');
  const W = Math.max(320, wrap.clientWidth || 900);
  const H = 260;
  const pad = { l: 54, r: 16, t: 16, b: 26 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.removeAttribute('preserveAspectRatio');

  const rows = d.stats.trend || [];
  const values = rows.map(metricValue);
  const maxRaw = Math.max(...values, 0);
  const max = niceMax(maxRaw * 1.12);
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x = (i) => pad.l + (rows.length <= 1 ? plotW / 2 : (plotW * i) / (rows.length - 1));
  const y = (v) => pad.t + plotH - (max ? (plotH * v) / max : 0);

  // 取当前主题色，深浅色切换后这里会重绘取到新值
  const cGrid = cssVar('--border', '#38383c');
  const cMute = cssVar('--text-3', '#6e6e73');
  const cAccent = cssVar('--accent', '#0a84ff');
  const cCard = cssVar('--card', '#1c1c1e');

  let g = '';

  // 网格 + Y 轴刻度
  for (let i = 0; i <= 4; i += 1) {
    const v = (max * i) / 4;
    const yy = y(v);
    g += `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}" stroke="${cGrid}" stroke-width="1"/>`;
    g += `<text x="${pad.l - 10}" y="${(yy + 4).toFixed(1)}" fill="${cMute}" font-size="10.5" text-anchor="end">${fmtCn(v)}</text>`;
  }

  // X 轴刻度
  const tickCount = Math.min(6, rows.length);
  for (let i = 0; i < tickCount; i += 1) {
    const idx = Math.round((rows.length - 1) * (i / Math.max(1, tickCount - 1)));
    const r = rows[idx];
    if (!r) continue;
    g += `<text x="${x(idx).toFixed(1)}" y="${H - 8}" fill="${cMute}" font-size="10.5" text-anchor="middle">${esc(r.day.slice(5))}</text>`;
  }

  if (!rows.length || maxRaw === 0) {
    g += `<text x="${W / 2}" y="${H / 2}" fill="${cMute}" font-size="13" text-anchor="middle">暂无流量数据 · 发一条 /v1/chat/completions 请求就会出现曲线</text>`;
    svg.innerHTML = `<defs></defs>${g}`;
    $('chartFrom').textContent = rows[0] ? rows[0].day : '--';
    $('chartTo').textContent = rows.length ? rows[rows.length - 1].day : '--';
    return;
  }

  const linePath = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(metricValue(r)).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${x(rows.length - 1).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;
  const lastIdx = rows.length - 1;

  g += `
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cAccent}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${cAccent}" stop-opacity="0"/>
      </linearGradient>
      <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3.2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <path d="${areaPath}" fill="url(#areaGrad)"/>
    <path d="${linePath}" fill="none" stroke="${cAccent}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>
    <circle cx="${x(lastIdx).toFixed(1)}" cy="${y(metricValue(rows[lastIdx])).toFixed(1)}" r="4.2" fill="${cAccent}"/>
    <circle cx="${x(lastIdx).toFixed(1)}" cy="${y(metricValue(rows[lastIdx])).toFixed(1)}" r="8" fill="${cAccent}" opacity="0.18"/>
  `;

  g += `<g id="hoverLayer" style="display:none"><line id="hoverLine" y1="${pad.t}" y2="${pad.t + plotH}" stroke="${cGrid}" stroke-width="1" stroke-dasharray="3 3"/><circle id="hoverDot" r="4" fill="${cCard}" stroke="${cAccent}" stroke-width="2"/></g>`;
  g += `<rect id="hoverRect" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair"/>`;

  svg.innerHTML = g;

  $('chartFrom').textContent = rows[0].day;
  $('chartTo').textContent = `${rows[rows.length - 1].day} · 近期合计 ${fmtCn(values.slice(-7).reduce((a, b) => a + b, 0))}`;

  // 悬停提示
  const tip = $('chartTip');
  const rect = svg.querySelector('#hoverRect');
  const layer = svg.querySelector('#hoverLayer');
  const hLine = svg.querySelector('#hoverLine');
  const hDot = svg.querySelector('#hoverDot');
  rect.addEventListener('mousemove', (ev) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / W;
    const px = (ev.clientX - box.left) / scale;
    let idx = Math.round(((px - pad.l) / plotW) * (rows.length - 1));
    idx = Math.max(0, Math.min(rows.length - 1, idx));
    const r = rows[idx];
    const cx = x(idx);
    const cy = y(metricValue(r));
    layer.style.display = '';
    hLine.setAttribute('x1', cx);
    hLine.setAttribute('x2', cx);
    hDot.setAttribute('cx', cx);
    hDot.setAttribute('cy', cy);
    tip.classList.remove('hidden');
    tip.innerHTML = `<div class="tip-day">${esc(r.day)}</div>
      <div class="tip-val"><b>${fmtCn(metricValue(r))}</b> ${METRIC_LABEL[state.metric]}</div>
      <div class="tip-meta">调用 ${fmtInt(r.calls)} · 输入 ${fmtCn(r.input)} · 输出 ${fmtCn(r.output)}</div>`;
    const tipW = tip.offsetWidth || 160;
    let left = (cx * scale) - tipW / 2;
    left = Math.max(4, Math.min(box.width - tipW - 4, left));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, cy * scale - 74)}px`;
  });
  rect.addEventListener('mouseleave', () => {
    layer.style.display = 'none';
    tip.classList.add('hidden');
  });

  if (!chartObserver) {
    chartObserver = new ResizeObserver(() => renderChart());
    chartObserver.observe(wrap);
  }
}

/* --------------------------------------------------------------- 排行榜 */
function renderLeaderboard(d) {
  const rows = d.stats.leaderboard || [];
  const totalTokens = d.stats.totals.totalTokens || 1;
  const box = $('leaderboard');
  if (!rows.length) {
    box.innerHTML = '<li class="muted" style="padding:14px 0">暂无调用记录</li>';
  } else {
    box.innerHTML = rows.map((r, i) => {
      const width = Math.max(2, Math.min(100, (r.share || 0) * 100));
      const rank = r.aggregated ? '··' : String(i + 1).padStart(2, '0');
      return `<li class="lb-row">
        <div class="lb-rank">${rank}</div>
        <div class="lb-main">
          <div class="lb-name"><span title="${esc(r.name)}">${esc(r.name)}</span><em>${fmtInt(r.calls)} 次</em></div>
          <div class="lb-bar"><i style="width:${width.toFixed(1)}%"></i></div>
        </div>
        <div class="lb-val"><b>${fmtCn(r.total)}</b><small>${fmtPct(r.share)}</small></div>
      </li>`;
    }).join('');
  }
  const peak = d.stats.peakDay;
  $('peakDay').textContent = peak ? peak.day : '--';
  $('peakValue').textContent = peak ? `${fmtCn(peak.total)} Tokens（${fmtInt(peak.calls)} 次调用）` : '--';
  $('footStart').textContent = `自 ${d.stats.meta.firstDay} 起计 · 共 ${d.stats.meta.totalDays} 天`;
  $('footVersion').textContent = `Node ${d.gateway.nodeVersion} · 端口 ${d.gateway.port} · 网关 v${d.gateway.version || '?'} · 更新 ${d.gateway.update && d.gateway.update.hasUpdate ? '待升级→' + d.gateway.update.latest : '最新'}`;
}

/* ----------------------------------------------------------- 接入信息 */
function renderGateway(d) {
  $('baseUrl').textContent = d.gateway.baseUrl;
  $('clientKey').textContent = d.gateway.clientKey;
  renderSnippet(d);
}

function snippetText(d) {
  const base = d.gateway.baseUrl;
  const key = d.gateway.clientKey;
  const k = key.startsWith('(') ? 'YOUR_GATEWAY_KEY' : key;
  if (state.snippet === 'curl') {
    return `curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${k}" \\
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "你好，自我介绍一下"}],
    "stream": true
  }'`;
  }
  if (state.snippet === 'python') {
    return `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${k}",
)

resp = client.chat.completions.create(
    model="auto",                      # 也可以写 deepseek-r1 / gemini-flash / glm-flash …
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
print(resp.model, "由", resp.x_gateway["provider_name"], "提供")`;
  }
  if (state.snippet === 'node') {
    return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: "${k}",
});

const resp = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "你好" }],
});
console.log(resp.choices[0].message.content);`;
  }
  return `# 任意 OpenAI 兼容客户端的通用填法
接口地址 / Base URL : ${base}
API Key            : ${k}
模型名称           : auto           # 自动挑一个可用的免费模型
                     或 指定模型名    # deepseek-r1 / gemini-flash / glm-flash / llama-3.3-70b …

# 已验证可用的客户端
#   Cherry Studio  → 设置 → 模型服务 → 添加「OpenAI」类型 → 填入上面三项
#   NextChat       → 设置 → 自定义接口 → 接口地址填 ${base}，模型勾选「自定义」
#   LobeChat       → 语言模型 → OpenAI → 代理地址 ${base}
#   ChatBox / Dify / RAGFlow / One-API 上游 → 同样按 OpenAI 兼容填
#   Cursor / Continue / Cline → OpenAI Compatible，Base URL 同上`;
}

function renderSnippet(d) {
  $('snippetBox').textContent = snippetText(d);
}

/* ----------------------------------------------------------- 渠道状态 */
function provPill(p) {
  if (!p.enabled) return '<span class="pill pill-idle">已停用</span>';
  if (!p.keys.length) return '<span class="pill pill-idle">未配密钥</span>';
  const h = p.health;
  if (h.ok > 0 && h.ok === h.total) return `<span class="pill pill-ok">健康 ${h.ok}/${h.total}</span>`;
  if (h.ok > 0) return `<span class="pill pill-warn">部分可用 ${h.ok}/${h.total}</span>`;
  if (h.limited > 0 || h.cooldown > 0) return `<span class="pill pill-warn">冷却中 ${h.ok}/${h.total}</span>`;
  return `<span class="pill pill-off">不可用 ${h.ok}/${h.total}</span>`;
}

function renderProviders(d) {
  const box = $('providerList');
  const list = d.providers.slice().sort((a, b) => {
    const sa = (b.usage && b.usage.calls) || 0;
    const sb = (a.usage && a.usage.calls) || 0;
    if (sa !== sb) return sa - sb;
    return b.priority - a.priority;
  });
  $('providerSummary').textContent = `${d.summary.providersEnabled}/${d.summary.providers} 启用 · ${d.summary.providersWithKey} 已配密钥 · ${d.summary.healthyKeys}/${d.summary.keys} 密钥健康`;

  box.innerHTML = list.map((p) => {
    const cls = ['prov', p.enabled ? '' : 'disabled', p.keys.length && p.health.ok === 0 ? 'offline' : ''].join(' ');
    const usage = p.usage || { calls: 0, input: 0, output: 0 };
    return `<div class="${cls}">
      <div>
        <div class="prov-top">
          <span class="prov-name">${esc(p.name)}</span>
          ${provPill(p)}
          <span class="pill pill-idle">优先级 ${p.priority}</span>
          ${p.keyless ? '<span class="pill pill-idle">免密钥</span>' : ''}
        </div>
        <div class="prov-meta">${p.modelsLabel || p.modelCount + ' 个模型'} · 密钥 ${p.keys.length} · 限速 ${p.rpm || '-'} RPM / ${p.rpd || '-'} RPD · 平均延迟 ${fmtMs(p.health.avgLatencyMs)}</div>
        <div class="prov-note">${esc(p.note || '')}</div>
      </div>
      <div>
        <div class="prov-right">
          <b>${fmtCn(usage.input + usage.output)}</b> Tokens<br>
          ${fmtInt(usage.calls)} 次调用<br>
          ${p.homepage ? `<a class="prov-link" href="${esc(p.homepage)}" target="_blank" rel="noreferrer">申请密钥 ↗</a>` : ''}
        </div>
        <div style="text-align:right;margin-top:6px">
          <button class="btn btn-mini" data-toggle-provider="${esc(p.id)}" data-enabled="${p.enabled ? '1' : '0'}" type="button">${p.enabled ? '停用' : '启用'}</button>
        </div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-toggle-provider]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-toggle-provider');
      const enabled = btn.getAttribute('data-enabled') === '1';
      btn.disabled = true;
      try {
        await api('/admin/api/provider-toggle', {
          method: 'POST',
          body: JSON.stringify({ providerId: id, enabled: !enabled }),
        });
        await load();
      } catch (err) {
        showAlert(`切换失败：${err.message}`);
        btn.disabled = false;
      }
    });
  });
}

/* ----------------------------------------------------------- 模型清单 */
function renderModels() {
  const box = $('modelList');
  const q = state.modelFilter.trim().toLowerCase();
  const items = state.models.filter((m) => {
    if (!q) return true;
    return String(m.id).toLowerCase().includes(q) || String(m.description || '').toLowerCase().includes(q);
  });
  $('modelSummary').textContent = `${state.models.length} 个可选模型${q ? ` · 匹配 ${items.length}` : ''}`;
  if (!items.length) {
    box.innerHTML = '<div class="muted" style="padding:12px 0">没有匹配的模型</div>';
    return;
  }
  box.innerHTML = items.slice(0, 400).map((m) => {
    const gateway = m.owned_by === 'gateway';
    return `<div class="model">
      <div style="min-width:0">
        <div class="model-id">${esc(m.id)}</div>
        <div class="model-sub">${esc(m.description || '')}${m.context_length ? ` · 上下文 ${fmtCn(m.context_length)}` : ''}</div>
      </div>
      <div style="white-space:nowrap">
        ${gateway ? '<span class="model-tag">网关内置</span>' : `<span class="model-tag">${m.providers} 个渠道</span>`}
      </div>
    </div>`;
  }).join('');
}

/* --------------------------------------------------------------- 密钥池 */
function renderKeys(d) {
  const sel = $('keyProvider');
  const current = sel.value;
  sel.innerHTML = d.providers
    .filter((p) => !p.keyless && p.type !== 'mock')
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
  if (current) sel.value = current;

  const box = $('keyList');
  const items = [];
  for (const p of d.providers) {
    for (const k of p.keys) {
      items.push({ p, k });
    }
  }
  if (!items.length) {
    box.innerHTML = '<div class="muted">还没有任何密钥。选一个渠道、粘贴密钥后点「添加密钥」，网关会自动把该渠道的免费模型纳入调度。</div>';
    return;
  }
  box.innerHTML = items.map(({ p, k }) => {
    const st = k.status === 'ok' ? 'pill-ok' : k.status === 'invalid' ? 'pill-off' : 'pill-warn';
    const stText = k.status === 'ok' ? '可用' : k.status === 'invalid' ? '失效' : k.status === 'limited' ? '限流' : '冷却';
    return `<div class="key-item">
      <div class="kx">${esc(k.mask)}<small>${esc(p.name)} · <span class="pill ${st}">${stText}</span> 今日 ${k.usageToday}${k.rpd ? '/' + k.rpd : ''} 次 · 成功 ${k.ok} / 失败 ${k.fail}</small></div>
      ${k.keyless ? '' : `<button class="key-del" data-provider="${esc(p.id)}" data-key="${esc(k.mask)}" type="button">删除</button>`}
    </div>`;
  }).join('');

  box.querySelectorAll('.key-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('确认删除这个密钥？')) return;
      btn.disabled = true;
      try {
        await api('/admin/api/keys', {
          method: 'DELETE',
          body: JSON.stringify({
            providerId: btn.getAttribute('data-provider'),
            key: btn.getAttribute('data-key'),
          }),
        });
        await load();
      } catch (err) {
        showAlert(`删除失败：${err.message}`);
        btn.disabled = false;
      }
    });
  });
}

/* ----------------------------------------------------------- 自动更新 */
let updateStatusTimer = null;

function renderUpdate(d) {
  const cur = (d && d.gateway && d.gateway.version) || '?';
  const upd = (d && d.gateway && d.gateway.update) || {};
  $('updateCurrent').textContent = cur;
  $('updateLatest').textContent = upd.latest || cur;
  $('updateBadge').classList.toggle('hidden', !upd.hasUpdate);
  if (upd.hasUpdate) {
    $('updateSummary').textContent = `发现新版本 ${upd.latest}`;
  } else if (upd.checkedAt) {
    $('updateSummary').textContent = `已是最新（${upd.latest || cur}）`;
  } else {
    $('updateSummary').textContent = '点击「检查更新」查看最新版本';
  }
  $('updateApplyBtn').disabled = !upd.hasUpdate;
}

function showUpdateMsg(msg, isError) {
  const box = $('updateMsg');
  box.classList.remove('hidden');
  box.innerHTML = `<div class="${isError ? 'tr-content' : 'tr-meta'}">${esc(msg)}</div>`;
}

async function loadUpdateConfig() {
  // 更新源固定指向官方仓库，前端只展示仓库名，不再提供配置入口
  try {
    const cfg = await api('/admin/api/update/config');
    state.updateCfg = cfg;
    const label = (cfg.sources && cfg.sources[0] && cfg.sources[0].label) || '';
    const src = $('updateSource');
    if (src) src.textContent = label.replace(/^GitHub（|）$/g, '') || '373065025/free-model-gateway';
  } catch (_e) { /* 忽略 */ }

  // 可回滚的历史版本
  try {
    const backups = await api('/admin/api/update/backups');
    const sel = $('updateRollbackSel');
    if (sel) {
      const list = backups.backups || [];
      sel.innerHTML = list.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
      sel.classList.toggle('hidden', !list.length);
      const rb = $('updateRollbackBtn');
      if (rb) rb.disabled = !list.length;
    }
  } catch (_e) { /* 忽略 */ }
}

async function refreshUpdateState() {
  try {
    const r = await api('/admin/api/update');
    const cur = $('updateCurrent').textContent;
    $('updateLatest').textContent = r.latest || cur;
    $('updateBadge').classList.toggle('hidden', !r.hasUpdate);
    $('updateApplyBtn').disabled = !r.hasUpdate;
    $('updateSummary').textContent = r.hasUpdate
      ? `发现新版本 ${r.latest}` : `已是最新（${r.latest || cur}）`;
  } catch (_e) { /* 忽略 */ }
}

async function checkUpdate() {
  const btn = $('updateCheckBtn');
  btn.disabled = true;
  btn.textContent = '检查中…';
  showUpdateMsg('正在向 GitHub 查询最新版本…', false);
  try {
    const r = await api('/admin/api/update/check', { method: 'POST' });
    if (r.hasUpdate) {
      showUpdateMsg(`发现新版本 ${r.latest}。点「应用更新」即可升级。`, false);
      await refreshUpdateState();
    } else if (r.error) {
      showUpdateMsg(`检查失败：${r.error}`, true);
    } else {
      showUpdateMsg(`已是最新版本（${r.latest}）。`, false);
    }
  } catch (err) {
    showUpdateMsg(`检查失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
    await loadUpdateConfig();
  }
}

async function pollUpdateStatus() {
  if (updateStatusTimer) clearInterval(updateStatusTimer);
  updateStatusTimer = setInterval(async () => {
    try {
      const s = await api('/admin/api/update/status');
      if (s.state && s.state !== 'idle') {
        showUpdateMsg(`${s.message || s.state}（${s.progress || 0}%）`, false);
      }
      if (['done', 'error'].includes(s.state)) {
        clearInterval(updateStatusTimer);
        updateStatusTimer = null;
        if (s.state === 'error') showUpdateMsg(`更新失败：${s.error || ''}`, true);
        else showUpdateMsg('更新完成，应用正在重启…', false);
        await refreshUpdateState();
        await loadUpdateConfig();
      }
    } catch (_e) { /* 重启期间会短暂失败，忽略 */ }
  }, 1500);
}

async function applyUpdate() {
  const btn = $('updateApplyBtn');
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const r = await api('/admin/api/update/apply', { method: 'POST' });
    if (r.error) {
      showUpdateMsg(`无法更新：${r.error}`, true);
      btn.disabled = false;
      btn.textContent = '应用更新';
      return;
    }
    showUpdateMsg(`已开始更新到 ${r.version}，下载/校验/重启中…`, false);
    pollUpdateStatus();
  } catch (err) {
    showUpdateMsg(`更新失败：${err.message}`, true);
    btn.disabled = false;
    btn.textContent = '应用更新';
  }
}

async function rollbackUpdate() {
  const sel = $('updateRollbackSel');
  if (sel.classList.contains('hidden') || !sel.value) return;
  if (!confirm(`确认回滚到版本 ${sel.value}？应用将重启。`)) return;
  try {
    const r = await api('/admin/api/update/rollback', { method: 'POST', body: JSON.stringify({ version: sel.value }) });
    if (r.error) { showUpdateMsg(`回滚失败：${r.error}`, true); return; }
    showUpdateMsg(`已回滚到 ${r.version}，应用正在重启…`, false);
  } catch (err) {
    showUpdateMsg(`回滚失败：${err.message}`, true);
  }
}

/* ----------------------------------------------------------------- 日志 */
function renderLogs(d) {
  const logs = d.recentLogs || [];
  const body = $('logBody');
  if (!logs.length) {
    body.innerHTML = '<tr><td colspan="9" class="muted" style="padding:16px">暂无请求记录</td></tr>';
    return;
  }
  body.innerHTML = logs.map((l) => {
    const time = String(l.ts || '').slice(11, 19);
    return `<tr>
      <td class="mono">${esc(time)}</td>
      <td class="mono">${esc(l.model)}</td>
      <td>${esc(l.provider)}</td>
      <td class="${l.ok ? 'tag-ok' : 'tag-fail'}">${l.ok ? (l.stream ? '成功·流式' : '成功') : '失败'}</td>
      <td class="mono">${fmtInt(l.input)}</td>
      <td class="mono">${fmtInt(l.output)}</td>
      <td class="mono">${fmtMs(l.latencyMs)}</td>
      <td class="mono">${l.attempts}</td>
      <td title="${esc(l.error)}" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc(l.route || '')}${l.error ? ` · ${esc(String(l.error).slice(0, 70))}` : ''}</td>
    </tr>`;
  }).join('');
}

function renderFooter(d) {
  $('footUpdated').textContent = `最后更新 ${new Date(d.generatedAt).toLocaleTimeString('zh-CN')}`;
}

/* ------------------------------------------------- 用户许可与免责同意书 */
/* 首次使用（或同意书升版）必须明确同意；弹窗不能通过 Esc / 点遮罩 / 点关闭按钮跳过。 */

/** 已经渲染进弹窗的同意书版本；用于避免重复拉取把用户的勾选状态冲掉 */
let eulaShownVersion = '';
/** 同意书请求序号：同意之后，早先发出的请求回来时不能再把弹窗重新打开 */
let eulaReqSeq = 0;

function eulaFoot(which) {
  ['eulaFoot', 'eulaDeclinedFoot', 'eulaReadFoot'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== which);
  });
}

function openEulaMask() {
  const mask = $('eulaModal');
  if (mask && mask.classList.contains('hidden')) {
    mask.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }
}

function hideEulaModal() {
  const mask = $('eulaModal');
  if (!mask) return;
  mask.classList.add('hidden');
  document.body.classList.remove('modal-open');
  eulaShownVersion = '';
}

/** 把同意书内容渲染进弹窗；未同意时强制走「滚到底 → 勾选 → 同意」 */
function renderEula(r) {
  const accepted = !!r.accepted;
  const text = r.text || {};
  const ver = text.version || r.version || '--';
  $('eulaVersionBadge').textContent = `v${ver}`;
  $('eulaSub').textContent = `版本 v${ver} · 更新于 ${text.updatedAt || r.updatedAt || '--'}`;
  eulaShownVersion = accepted ? '' : ver;

  const secs = text.sections || [];
  const body = $('eulaBody');
  body.innerHTML = secs.length
    ? secs.map((s) => `<section class="eula-sec">
        <h3>${esc(s.title)}</h3>
        ${(s.body || []).map((p) => `<p>${esc(p)}</p>`).join('')}
      </section>`).join('')
    : '<p class="eula-loading">条款正文为空，请刷新页面重试。</p>';
  body.scrollTop = 0;

  if (accepted) {
    // 已同意：只读回看
    $('eulaCloseBtn').classList.remove('hidden');
    $('eulaReadInfo').textContent = r.acceptedAt
      ? `你已于 ${new Date(r.acceptedAt).toLocaleString('zh-CN')} 同意本同意书（版本 v${ver}）。`
      : `你已同意本同意书（版本 v${ver}）。`;
    eulaFoot('eulaReadFoot');
    return;
  }

  $('eulaCloseBtn').classList.add('hidden');
  eulaFoot('eulaFoot');
  const agree = $('eulaAgree');
  agree.checked = false;
  agree.disabled = true;
  $('eulaAcceptBtn').disabled = true;
  $('eulaTip').textContent = '请向下滚动阅读至条款结尾，然后再勾选同意。';
  // 正文很短、无需滚动时直接放开勾选
  setTimeout(checkEulaScrolled, 0);
}

/** 取回同意书状态并渲染；forceReadonly 用于页脚「用户协议」只读回看 */
async function loadEula(forceReadonly) {
  const seq = ++eulaReqSeq;
  try {
    const r = await api('/admin/api/eula');
    // 期间用户可能已经点了「同意」，或又发起了一次加载 —— 丢弃过期结果，
    // 否则一个慢请求回来会把刚关掉的弹窗重新打开。
    if (seq !== eulaReqSeq) return;
    state.eula = r;
    if (r.accepted && !forceReadonly) { hideEulaModal(); return; }
    openEulaMask();
    renderEula(r);
  } catch (err) {
    if (seq !== eulaReqSeq) return;
    openEulaMask();
    const body = $('eulaBody');
    if (body) body.innerHTML = `<p class="eula-loading">加载条款失败：${esc(err.message)}</p>`;
  }
}

/** 被门禁拦截时调用：弹出同意书 */
function showEulaModal() {
  const mask = $('eulaModal');
  if (!mask) return;
  const wasHidden = mask.classList.contains('hidden');
  openEulaMask();
  // 同意书已经在展示同一版本时不再重复拉取/重渲染：
  // 否则每一个被门禁拦下的请求都会把用户刚勾选的同意状态重置掉。
  if (!wasHidden && eulaShownVersion) return;
  loadEula(false);
}

/** 页脚入口：已同意则进入只读回看模式 */
function openEulaReadonly() {
  openEulaMask();
  loadEula(true);
}

/** 只有读到底部才允许勾选「同意」 */
function checkEulaScrolled() {
  const body = $('eulaBody');
  const agree = $('eulaAgree');
  if (!body || !agree || !agree.disabled) return;
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 24;
  if (atBottom) {
    agree.disabled = false;
    $('eulaTip').textContent = '已阅读至结尾，请勾选上方选项后点击「同意并开始使用」。';
  }
}

async function acceptEula() {
  const btn = $('eulaAcceptBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '正在保存…';
  try {
    await api('/admin/api/eula/accept', { method: 'POST', body: '{}' });
    // 让所有还在飞的同意书请求作废，避免它们回来又把弹窗打开
    eulaReqSeq += 1;
    hideEulaModal();
    showAlert('');
    // 同意前这些接口都被门禁挡着，所以同意后要把首屏数据完整补一遍
    await load();
    await fillModelSelect();
    await loadUpdateConfig();
    await loadNotify();
  } catch (err) {
    // 局域网 / 远程访问时最常见的原因就是「没有管理令牌」。
    // 服务端只在回环地址下发令牌，所以这里把可照做的办法直接写清楚，
    // 别让用户对着一句「管理令牌无效」发呆。
    $('eulaTip').textContent = err.status === 401
      ? '保存失败：这个地址没有管理令牌。请改用 http://<网关地址>:8790/?token=<管理令牌> 打开本页（令牌在 NAS 数据目录的 gateway-key.txt 里，也打印在启动日志中），或点右上角齿轮手工粘贴。'
      : `保存失败：${err.message}`;
    btn.disabled = false;
  } finally {
    btn.textContent = old;
  }
}

/* ------------------------------------------------------------- 每日推送 */
function notifyMsg(html, isErr) {
  const box = $('notifyMsg');
  if (!box) return;
  if (!html) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="tr-content" style="${isErr ? 'color:var(--red)' : ''}">${html}</div>`;
}

function renderNotify(cfg) {
  state.notify = cfg;
  if (!cfg) return;
  $('notifyEnabled').checked = !!cfg.enabled;
  $('notifyTime').value = cfg.timeOfDay || '09:00';
  $('notifyChannel').value = cfg.channel || 'wechat';
  $('notifyTopic').value = cfg.topic || '';
  $('notifySkipIdle').checked = !!cfg.skipIdle;

  const tokenInput = $('notifyToken');
  tokenInput.value = '';
  tokenInput.placeholder = cfg.hasToken
    ? `已配置：${cfg.tokenMask}（留空则保持不变）`
    : '粘贴 PushPlus token';

  const hint = $('notifyTokenHint');
  if (cfg.hasToken) {
    hint.textContent = `Token 已保存在本机：${cfg.tokenMask}。要更换就直接粘贴新 token 后保存；要清除请点右侧「清除」。`;
  } else {
    hint.textContent = '在 pushplus.plus 微信扫码登录后，于「一对一推送」中获取。';
  }

  const parts = [];
  parts.push(cfg.enabled ? '已开启' : '未开启');
  if (cfg.hasToken) parts.push('token 已配置'); else parts.push('未配置 token');
  parts.push(`每天 ${cfg.timeOfDay} 推送`);
  if (cfg.lastResult && cfg.lastResult.at) {
    const t = new Date(cfg.lastResult.at).toLocaleString('zh-CN');
    parts.push(cfg.lastResult.ok ? `上次推送成功（${t}）` : `上次推送失败：${cfg.lastResult.msg || '未知'}（${t}）`);
  }
  $('notifySummary').textContent = parts.join(' · ');
}

async function loadNotify() {
  try {
    const cfg = await api('/admin/api/notify/config');
    notifyMsg('');
    renderNotify(cfg);
  } catch (err) {
    if (err.code !== 'eula_required') notifyMsg(`读取推送配置失败：${esc(err.message)}`, true);
  }
}

async function saveNotify() {
  const btn = $('notifySaveBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '保存中…';
  try {
    const payload = {
      enabled: $('notifyEnabled').checked,
      timeOfDay: $('notifyTime').value || '09:00',
      channel: $('notifyChannel').value,
      topic: $('notifyTopic').value.trim(),
      skipIdle: $('notifySkipIdle').checked,
    };
    const t = $('notifyToken').value.trim();
    if (t) payload.token = t;
    const cfg = await api('/admin/api/notify/config', { method: 'PUT', body: JSON.stringify(payload) });
    renderNotify(cfg);
    notifyMsg('设置已保存。' + (cfg.enabled ? (cfg.hasToken ? ' 将按设定时间推送日报。' : ' 但还没配置 token，不会真正推送。') : ''));
  } catch (err) {
    notifyMsg(`保存失败：${esc(err.message)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function clearNotifyToken() {
  if (!confirm('确认清除已保存的 PushPlus token？清除后不会再有推送，直到重新填入。')) return;
  try {
    const cfg = await api('/admin/api/notify/config', { method: 'PUT', body: JSON.stringify({ token: '' }) });
    renderNotify(cfg);
    notifyMsg('已清除本机保存的 token。');
  } catch (err) {
    notifyMsg(`清除失败：${esc(err.message)}`, true);
  }
}

async function previewNotify() {
  const btn = $('notifyPreviewBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '生成中…';
  try {
    const r = await api('/admin/api/notify/preview');
    const box = $('notifyPreview');
    box.classList.remove('hidden');
    box.innerHTML = `<div class="np-title">标题：${esc(r.title)}　|　渠道：${esc(r.channel)}　|　时间：${esc(r.timeOfDay)}</div>${r.html}`;
  } catch (err) {
    notifyMsg(`预览失败：${esc(err.message)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function testNotify() {
  const btn = $('notifyTestBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '发送中…';
  try {
    const r = await api('/admin/api/notify/test', { method: 'POST', body: '{}' });
    if (r.ok) notifyMsg('测试消息已提交给 PushPlus，请查看微信是否收到（异步投递，通常几秒内到达）。');
    else notifyMsg(`测试失败：${esc((r.result && r.result.msg) || '未知错误')}`, true);
    await loadNotify();
  } catch (err) {
    notifyMsg(`测试失败：${esc(err.message)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function sendNotifyNow() {
  const btn = $('notifySendBtn');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '推送中…';
  try {
    const r = await api('/admin/api/notify/send', { method: 'POST', body: '{}' });
    if (r.ok) notifyMsg('已立即推送一次日报。');
    else if (r.skipped) notifyMsg(`已跳过：${esc(r.error || '今日无调用')}`);
    else notifyMsg(`推送失败：${esc((r.result && r.result.msg) || r.error || '未知错误')}`, true);
    await loadNotify();
  } catch (err) {
    notifyMsg(`推送失败：${esc(err.message)}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ----------------------------------------------------------------- 交互 */
function bindEvents() {
  $('refreshBtn').addEventListener('click', load);

  // 主题切换：自动 / 浅色 / 深色
  const seg = $('themeSeg');
  if (seg) {
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.seg-btn');
      if (!btn) return;
      setTheme(btn.getAttribute('data-theme'));
    });
  }

  // 设置浮层（管理令牌）
  const settingsBtn = $('settingsBtn');
  const settingsPanel = $('settingsPanel');
  const toggleSettings = (force) => {
    if (!settingsPanel || !settingsBtn) return;
    const show = typeof force === 'boolean' ? force : settingsPanel.classList.contains('hidden');
    settingsPanel.classList.toggle('hidden', !show);
    settingsBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
  };
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleSettings();
    });
  }
  if (settingsPanel) settingsPanel.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', () => toggleSettings(false));
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') toggleSettings(false); });

  const tokenInput = $('tokenInput');
  if (tokenInput) {
    tokenInput.value = state.token;
    tokenInput.addEventListener('change', () => {
      state.token = tokenInput.value.trim();
      lsSet(TOKEN_KEY, state.token);
      load();
    });
  }

  $('chartSeg').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.seg-btn');
    if (!btn) return;
    state.metric = btn.getAttribute('data-metric');
    document.querySelectorAll('#chartSeg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderChart();
  });

  $('snippetTabs').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.tab');
    if (!btn) return;
    state.snippet = btn.getAttribute('data-tab');
    document.querySelectorAll('#snippetTabs .tab').forEach((b) => b.classList.toggle('active', b === btn));
    renderSnippet(state.data);
  });

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-copy]');
    if (!btn) return;
    const el = $(btn.getAttribute('data-copy'));
    if (!el) return;
    const text = el.textContent;
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1400);
    } catch (_e) {
      showAlert('复制失败，请手动选中文本复制。');
    }
  });

  $('modelFilter').addEventListener('input', () => {
    state.modelFilter = $('modelFilter').value;
    renderModels();
  });

  $('testBtn').addEventListener('click', async () => {
    const btn = $('testBtn');
    btn.disabled = true;
    btn.textContent = '测试中…';
    const box = $('testResult');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="muted">正在通过网关发起请求…</div>';
    try {
      const r = await api('/admin/api/test', {
        method: 'POST',
        body: JSON.stringify({ model: $('testModel').value, prompt: $('testPrompt').value }),
      });
      const attempts = (r.attempts || []).map((a) => `${a.provider}${a.ok ? ' ✓' : ` ✗(${a.kind || a.status || 'err'})`}`).join(' → ');
      box.innerHTML = `
        <div class="tr-meta">
          <span class="${r.ok ? 'c-green' : ''}">${r.ok ? '成功' : '失败'}</span>
          <span>模型 ${esc(r.model)}</span>
          ${r.provider ? `<span>实际渠道 <b class="c-gold">${esc(r.provider)}</b></span>` : ''}
          ${r.upstreamModel ? `<span>上游模型 ${esc(r.upstreamModel)}</span>` : ''}
          <span>耗时 ${fmtMs(r.latencyMs)}</span>
          ${r.usage ? `<span>输入 ${fmtInt(r.usage.input)} / 输出 ${fmtInt(r.usage.output)} tokens</span>` : ''}
        </div>
        <div class="tr-content">${esc(r.ok ? r.content : JSON.stringify(r.error, null, 2))}</div>
        <div class="tr-att">尝试链路：${esc(attempts || '无')}</div>`;
    } catch (err) {
      box.innerHTML = `<div class="tr-content">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '发送测试';
      load();
    }
  });

  $('keyAddBtn').addEventListener('click', async () => {
    const btn = $('keyAddBtn');
    const providerId = $('keyProvider').value;
    const keys = $('keyInput').value.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (!providerId || !keys.length) {
      showAlert('请先选择渠道并粘贴至少一个密钥。');
      return;
    }
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({ providerId, keys }) });
      $('keyInput').value = '';
      showAlert('');
      await load();
    } catch (err) {
      showAlert(`保存失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '添加密钥';
    }
  });

  $('discoverBtn').addEventListener('click', async () => {
    const btn = $('discoverBtn');
    btn.disabled = true;
    btn.textContent = '探测中…';
    try {
      const r = await api('/admin/api/discover', { method: 'POST', body: '{}' });
      const ok = r.results.filter((x) => x.ok).length;
      const added = r.results.reduce((s, x) => s + (x.added || 0), 0);
      showAlert(`免费模型发现完成：${ok}/${r.results.length} 个渠道探测成功，新增 ${added} 个候选模型，当前共 ${r.models} 个模型。`);
      await load();
    } catch (err) {
      showAlert(`探测失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '重新发现免费模型';
    }
  });

  $('autoRefresh').addEventListener('change', () => {
    if ($('autoRefresh').checked) startPolling();
    else stopPolling();
  });

  $('updateCheckBtn').addEventListener('click', checkUpdate);
  $('updateApplyBtn').addEventListener('click', applyUpdate);
  $('updateRollbackBtn').addEventListener('click', rollbackUpdate);

  // ---- 用户许可与免责同意书 ----
  const eulaBody = $('eulaBody');
  if (eulaBody) eulaBody.addEventListener('scroll', checkEulaScrolled);
  const eulaAgree = $('eulaAgree');
  if (eulaAgree) {
    eulaAgree.addEventListener('change', () => {
      $('eulaAcceptBtn').disabled = !eulaAgree.checked;
    });
  }
  const bind = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
  bind('eulaAcceptBtn', acceptEula);
  bind('eulaDeclineBtn', () => eulaFoot('eulaDeclinedFoot'));
  bind('eulaBackBtn', () => eulaFoot('eulaFoot'));
  bind('eulaCloseBtn', hideEulaModal);
  bind('eulaCloseBtn2', hideEulaModal);
  bind('eulaOpenBtn', openEulaReadonly);

  // ---- 每日推送 ----
  bind('notifySaveBtn', saveNotify);
  bind('notifyClearTokenBtn', clearNotifyToken);
  bind('notifyPreviewBtn', previewNotify);
  bind('notifyTestBtn', testNotify);
  bind('notifySendBtn', sendNotifyNow);
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const d = await api('/admin/api/overview');
      state.data = d;
      render();
    } catch (_e) { /* 静默 */ }
  }, 8000);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

async function fillModelSelect() {
  try {
    const res = await api('/admin/api/models');
    state.models = res.data || [];
    const sel = $('testModel');
    const preferred = ['auto', 'auto:fast', 'auto:reason', 'auto:code'];
    const ids = state.models.map((m) => m.id);
    const ordered = preferred.filter((p) => ids.includes(p)).concat(ids.filter((i) => !preferred.includes(i)));
    sel.innerHTML = ordered.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
    renderModels();
  } catch (_e) { /* 忽略 */ }
}

(async function init() {
  bindEvents();
  applyTheme();
  renderTheme();
  watchSystemTheme();
  await bootstrapToken();
  // 先看同意书：未同意时直接弹窗，并让后续请求走门禁
  await loadEula(false);
  await load();
  await fillModelSelect();
  await loadUpdateConfig();
  await loadNotify();
  startPolling();
})();
