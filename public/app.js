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

const state = {
  token: lsGet(TOKEN_KEY, ''),
  theme: lsGet(THEME_KEY, 'system'),
  data: null,
  metric: 'total',
  snippet: 'curl',
  modelFilter: '',
  models: [],
  updateCfg: null,
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
  const url = new URL(path, location.origin);
  if (state.token) url.searchParams.set('token', state.token);
  const res = await fetch(url.toString(), Object.assign({
    headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
  }, opts));
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { json = { raw: text }; }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
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
async function bootstrapToken() {
  if (state.token) return;
  try {
    const res = await fetch('/admin/api/bootstrap');
    if (!res.ok) return;
    const json = await res.json();
    if (json && json.token) {
      state.token = json.token;
      lsSet(TOKEN_KEY, state.token);
    }
  } catch (_e) { /* 忽略，走手动输入 */ }
}

async function load() {
  try {
    const data = await api('/admin/api/overview');
    state.data = data;
    showAlert('');
    render();
  } catch (err) {
    if (err.status === 401) {
      showAlert('需要管理令牌才能查看数据。点右上角齿轮图标填入令牌；本机打开通常会自动填充，令牌也可在 NAS 数据目录的 gateway-key.txt 里找到。');
      const panel = $('settingsPanel');
      if (panel) panel.classList.remove('hidden');
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
  await load();
  await fillModelSelect();
  await loadUpdateConfig();
  startPolling();
})();
