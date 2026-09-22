'use strict';

/**
 * 端到端自检：真的把网关跑起来，逐项验证对外接口、流式透传、故障转移与统计闭环。
 * 不依赖任何真实平台密钥——用内置模拟渠道 + 一个「故意失败」的假渠道即可覆盖完整链路。
 *
 *   node scripts/selfcheck.js
 *
 * 注意：自检会写入临时统计文件（系统 temp 目录），不会污染 data/usage.json 里的真实数据。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/index');
const { buildRegistry, CONFIG_DIR } = require('../src/config');
const eula = require('../src/eula');
const net = require('../src/net');

const USAGE_TMP = path.join(os.tmpdir(), `fmg-selfcheck-${Date.now()}.json`);
const NOTIFY_FILE = path.join(CONFIG_DIR, 'notify-config.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function startBrokenProvider() {
  const server = http.createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '60' });
    res.end(JSON.stringify({ error: { message: 'mock 429：故意触发的限流，用来验证故障转移' } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function request(base, options = {}) {
  const res = await fetch(`${base}${options.path}`, {
    method: options.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_e) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function readSse(base, options) {
  const res = await fetch(`${base}${options.path}`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}),
    body: JSON.stringify(options.body),
  });
  const decoder = new TextDecoder();
  let buf = '';
  let chunks = 0;
  let text = '';
  let done = false;
  for await (const piece of res.body) {
    buf += decoder.decode(piece, { stream: true });
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') { done = true; continue; }
      chunks += 1;
      try {
        const j = JSON.parse(payload);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        if (d && d.content) text += d.content;
      } catch (_e) { /* ignore */ }
    }
  }
  return { status: res.status, chunks, text, done, headers: res.headers };
}

async function main() {
  console.log('\n=== 免费模型聚合网关 · 端到端自检 ===\n');

  // 「未同意」门禁是靠进程内缓存 eulaOk 生效的，所以必须在 createApp 之前把同意记录清掉，
  // 才能在同一个进程里真实验证「首次使用 → 拒绝服务 → 同意 → 放行」的完整链路。
  const eulaAcceptedBefore = eula.isAccepted();
  eula.revoke();

  // 同理，推送配置也存在真实 CONFIG_DIR，先快照，跑完原样还原
  const notifyBefore = fs.existsSync(NOTIFY_FILE) ? fs.readFileSync(NOTIFY_FILE, 'utf-8') : null;

  const app = createApp({ usageFile: USAGE_TMP });
  const { ctx } = app;
  const cfg = ctx.cfg;

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${cfg.gatewayKey}` };
  const adminPath = (p) => `${p}${p.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.gatewayKey)}`;

  console.log(`服务已启动：${base}\n`);
  console.log('--- 第零阶段：首次使用的《用户许可与免责同意书》门禁 ---\n');

  // 0. 同意书门禁：未同意前除静态页 / healthz / 同意书自身外一律拒绝
  {
    const blocked = await request(base, { path: '/v1/models', headers: auth });
    check('未同意同意书时 /v1/* 被拒绝',
      blocked.status === 403 && blocked.json && blocked.json.error && blocked.json.error.code === 'eula_required',
      `状态 ${blocked.status}，code ${blocked.json && blocked.json.error && blocked.json.error.code}`);

    const blockedAdmin = await request(base, { path: adminPath('/admin/api/overview') });
    check('未同意同意书时管理接口被拒绝',
      blockedAdmin.status === 403 && blockedAdmin.json && blockedAdmin.json.error && blockedAdmin.json.error.code === 'eula_required',
      `状态 ${blockedAdmin.status}`);

    const hz = await request(base, { path: '/healthz' });
    check('未同意同意书时 /healthz 仍可探活（门禁不误伤探针）', hz.status === 200, `状态 ${hz.status}`);

    const page = await request(base, { path: '/' });
    check('未同意同意书时仍能打开 Dashboard（否则无法完成确认）',
      page.status === 200 && page.text.includes('eulaModal'), `状态 ${page.status}`);

    const info = await request(base, { path: adminPath('/admin/api/eula') });
    const secs = info.json && info.json.text && info.json.text.sections;
    check('同意书接口返回「未同意」状态与完整正文',
      info.status === 200 && info.json.accepted === false && Array.isArray(secs) && secs.length >= 10,
      `accepted=${info.json && info.json.accepted}，${Array.isArray(secs) ? secs.length : 0} 个章节`);
    check('同意书封面信息完整（标题 / 版本 / 摘要 / 更新日期）',
      !!(info.json && info.json.title && info.json.version && info.json.short && info.json.updatedAt),
      `${info.json && info.json.title} v${info.json && info.json.version}（${info.json && info.json.updatedAt}）`);

    // 回归：重装 / 换数据目录后网关密钥会重新生成，浏览器 localStorage 里那把旧令牌
    // 会让所有管理接口 401。同意书正文是公开法律文本，此时也必须能读到——
    // 否则用户会卡在一个「管理令牌无效」的报错上，既不知道要同意什么也没法自己修。
    const noToken = await request(base, { path: '/admin/api/eula' });
    const noTokenSecs = noToken.json && noToken.json.text && noToken.json.text.sections;
    check('同意书正文不依赖管理令牌（陈旧令牌也能读到条款）',
      noToken.status === 200 && Array.isArray(noTokenSecs) && noTokenSecs.length >= 10,
      `无令牌请求状态 ${noToken.status}，${Array.isArray(noTokenSecs) ? noTokenSecs.length : 0} 个章节`);

    const accept = await request(base, { path: adminPath('/admin/api/eula/accept'), method: 'POST', body: {} });
    check('提交同意后返回成功并带回接受时间',
      accept.status === 200 && accept.json.ok === true && accept.json.state.accepted === true && accept.json.state.acceptedAt > 0,
      `状态 ${accept.status}`);

    const after = await request(base, { path: '/v1/models', headers: auth });
    check('同意后 /v1/* 门禁立即解除', after.status === 200, `状态 ${after.status}`);

    const afterAdmin = await request(base, { path: adminPath('/admin/api/overview') });
    check('同意后管理接口门禁立即解除', afterAdmin.status === 200, `状态 ${afterAdmin.status}`);
  }

  console.log('\n--- 第零点五阶段：令牌自动下发的来源判定（内网免配置） ---\n');

  // 0.5 这组是纯函数单元测试：内网来源要能自动拿到令牌（大屏免配置），
  //     公网来源必须被挡住（否则端口一映射到公网就把管理权限漏出去）。
  {
    const lanOk = ['127.0.0.1', '::1', '::ffff:192.168.9.10', '192.168.9.77',
      '10.0.0.5', '172.16.0.1', '172.31.255.254', '169.254.1.1', 'fd00::1', 'fe80::1'];
    const lanBad = ['8.8.8.8', '1.1.1.1', '11.0.0.1', '172.32.0.1', '100.64.0.1', '198.51.100.7'];
    check('私有网段 / 回环全部判为内网',
      lanOk.every((ip) => net.isPrivateLan(ip)),
      lanOk.filter((ip) => !net.isPrivateLan(ip)).join(', ') || '全部命中');
    check('公网地址不会被判为内网',
      lanBad.every((ip) => !net.isPrivateLan(ip)),
      lanBad.filter((ip) => net.isPrivateLan(ip)).join(', ') || '全部排除');
    check('本机自身地址判为「网关所在机器」', net.isOwnAddress('127.0.0.1') === true);
    check('外部地址不会误判为「网关所在机器」', net.isOwnAddress('8.8.8.8') === false);
    check('trustLan 默认开启（局域网打开大屏免配置）', cfg.settings.trustLan === true,
      `trustLan=${cfg.settings.trustLan}`);
  }

  console.log('\n--- 第一阶段：不注入故障渠道，验证基础链路 ---\n');

  // 1. 健康检查
  {
    const r = await request(base, { path: '/healthz' });
    check('GET /healthz 返回 200 且结构正确', r.status === 200 && r.json.ok === true, `状态 ${r.status}`);
  }

  // 2. 鉴权
  {
    const r = await request(base, { path: '/v1/models' });
    check('未带密钥访问 /v1/models 被拒绝', r.status === 401 && !!r.json.error, `状态 ${r.status}`);
  }

  // 3. 模型清单
  let modelIds = [];
  {
    const r = await request(base, { path: '/v1/models', headers: auth });
    modelIds = (r.json && r.json.data ? r.json.data : []).map((m) => m.id);
    check('GET /v1/models 返回模型清单', r.status === 200 && modelIds.length > 0, `${modelIds.length} 个模型`);
    check('清单包含 auto 自动路由入口', modelIds.includes('auto'));
    check('清单包含内置模拟模型', modelIds.includes('mock'));
  }

  // 4. 非流式对话
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'mock', messages: [{ role: 'user', content: '自检：你好' }] },
    });
    const content = r.json && r.json.choices && r.json.choices[0].message.content;
    check('POST /v1/chat/completions 正常返回', r.status === 200 && !!content, `状态 ${r.status}，内容 ${String(content || '').length} 字`);
    check('响应带 usage 用量字段', !!(r.json && r.json.usage && r.json.usage.total_tokens > 0), JSON.stringify(r.json && r.json.usage));
    check('响应带 x_gateway 渠道来源信息', !!(r.json && r.json.x_gateway && r.json.x_gateway.provider));
  }

  // 5. 流式对话
  {
    const r = await readSse(base, {
      path: '/v1/chat/completions',
      headers: auth,
      body: { model: 'mock', messages: [{ role: 'user', content: '自检：流式' }], stream: true },
    });
    check('流式接口返回 SSE 且分块输出', r.status === 200 && r.chunks > 2 && r.text.length > 0, `${r.chunks} 个分块，${r.text.length} 字`);
    check('流式以 [DONE] 正常收尾', r.done === true);
    check('流式响应头为 text/event-stream',
      String(r.headers.get('content-type') || '').includes('text/event-stream'),
      String(r.headers.get('content-type')));
  }

  // 6. auto 自动路由
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'auto', messages: [{ role: 'user', content: '自检：auto 路由' }] },
    });
    check('model=auto 自动选路成功', r.status === 200 && !!(r.json.choices), `状态 ${r.status}`);
  }

  // 7. 能力标签路由
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'auto:reason', messages: [{ role: 'user', content: '自检：推理标签路由' }] },
    });
    check('model=auto:reason 能力标签路由可用', r.status === 200, `状态 ${r.status}`);
  }

  // 8. 未知模型
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'this-model-does-not-exist', messages: [{ role: 'user', content: 'x' }] },
    });
    check('未知模型返回 404 与可用模型提示', r.status === 404 && r.json.error.code === 'model_not_found', `状态 ${r.status}`);
  }

  // 9. 参数校验
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'mock' },
    });
    check('缺少 messages 时返回 400', r.status === 400, `状态 ${r.status}`);
  }

  // 10. 管理接口与统计闭环
  {
    const r = await request(base, { path: adminPath('/admin/api/overview') });
    const stats = r.json && r.json.stats;
    check('管理接口返回概览数据', r.status === 200 && !!stats, `状态 ${r.status}`);
    check('累计调用数已统计到自检流量', !!(stats && stats.totals.calls >= 5 && stats.totals.success >= 4 && stats.totals.failed >= 1),
      `calls=${stats && stats.totals.calls}, success=${stats && stats.totals.success}, failed=${stats && stats.totals.failed}`);
    check('输入/输出 token 均已计量', !!(stats && stats.totals.inputTokens > 0 && stats.totals.outputTokens > 0),
      `输入 ${stats && stats.totals.inputTokens} / 输出 ${stats && stats.totals.outputTokens}`);
    check('每日趋势序列已生成', !!(stats && stats.trend && stats.trend.length === 29), `${stats && stats.trend && stats.trend.length} 天`);
    check('模型排行榜已聚合', !!(stats && stats.leaderboard && stats.leaderboard.length > 0), `${stats && stats.leaderboard && stats.leaderboard.length} 行`);
    check('渠道健康状态可查', !!(r.json.providers && r.json.providers.length > 0), `${r.json.providers && r.json.providers.length} 个渠道`);
  }

  // 11. 日志（含失败记录）
  {
    const r = await request(base, { path: adminPath('/admin/api/logs?limit=50') });
    const logs = (r.json && r.json.logs) || [];
    check('请求日志已记录（含失败）', logs.length > 0 && logs.some((l) => !l.ok), `${logs.length} 条，其中失败 ${logs.filter((l) => !l.ok).length} 条`);
  }

  // 12. 管理端一键自测
  {
    const r = await request(base, {
      path: adminPath('/admin/api/test'),
      method: 'POST',
      body: { model: 'auto', prompt: '自检' },
    });
    check('管理端一键自测可用', r.status === 200 && r.json.ok === true, `渠道 ${r.json.provider || '-'}，耗时 ${r.json.latencyMs} ms`);
  }

  // 13. 管理令牌校验
  {
    const r = await request(base, { path: '/admin/api/overview?token=wrong-token' });
    check('错误管理令牌被拒绝', r.status === 401, `状态 ${r.status}`);
  }

  // 14. 本机可自动下发令牌；远程不下发
  {
    const r = await request(base, { path: '/admin/api/bootstrap' });
    check('网关所在机器自己访问可自动获取令牌（Dashboard 免配置）', r.status === 200 && !!r.json.token, `状态 ${r.status}`);

    // 拿到的令牌必须真能当管理令牌用 —— 这正是前端 `?token=<令牌>`
    // 跨局域网访问时唯一的零配置通路，断了用户就只能手工粘贴。
    const tk = (r.json && r.json.token) || '';
    if (tk) {
      const viaToken = await request(base, { path: `/admin/api/overview?token=${encodeURIComponent(tk)}` });
      check('下发的令牌可直接用于管理接口（?token= 通路可用）', viaToken.status === 200, `状态 ${viaToken.status}`);
    } else {
      check('下发的令牌可直接用于管理接口（?token= 通路可用）', false, '未取到令牌');
    }
  }

  // 15. Dashboard 静态页
  {
    const r = await request(base, { path: '/' });
    check('Dashboard 页面可访问', r.status === 200 && r.text.includes('监控大屏'), `状态 ${r.status}`);
  }

  // 15.5 每日推送（PushPlus）配置与日报预览
  {
    const FAKE = 'abcdef0123456789abcdef0123456789';

    const init = await request(base, { path: adminPath('/admin/api/notify/config') });
    check('推送配置接口返回默认值',
      init.status === 200 && init.json.enabled === false && init.json.hasToken === false
      && /^\d{2}:\d{2}$/.test(init.json.timeOfDay),
      `enabled=${init.json && init.json.enabled}，timeOfDay=${init.json && init.json.timeOfDay}`);
    check('推送配置默认不泄露任何 token 字段',
      !JSON.stringify(init.json).includes('token":"'),
      JSON.stringify(init.json).slice(0, 90));

    const badTime = await request(base, {
      path: adminPath('/admin/api/notify/config'), method: 'PUT', body: { timeOfDay: '25:99' },
    });
    check('非法推送时间被拒绝', badTime.status === 400 && !!badTime.json.error, `状态 ${badTime.status}`);

    const save = await request(base, {
      path: adminPath('/admin/api/notify/config'),
      method: 'PUT',
      body: { enabled: true, token: FAKE, timeOfDay: '08:30', skipIdle: true, channel: 'wechat' },
    });
    check('保存推送配置成功且回显已打码',
      save.status === 200 && save.json.hasToken === true && save.json.tokenMask.includes('****')
      && save.json.timeOfDay === '08:30' && save.json.enabled === true,
      `mask=${save.json && save.json.tokenMask}`);
    check('接口回显中不含明文 token', !JSON.stringify(save.json).includes(FAKE));

    const re = await request(base, { path: adminPath('/admin/api/notify/config') });
    check('推送配置已持久化', re.json.enabled === true && re.json.hasToken === true && re.json.timeOfDay === '08:30');

    const pv = await request(base, { path: adminPath('/admin/api/notify/preview') });
    check('日报预览可生成（标题 / 正文 / 摘要齐全）',
      pv.status === 200 && !!pv.json.title && pv.json.html.length > 200 && !!pv.json.summary,
      `${pv.json && pv.json.title}`);
    check('日报正文包含核心用量指标',
      pv.json.html.includes('今日调用') && pv.json.html.includes('成功率') && pv.json.html.includes('渠道健康'));
    check('日报预览绝不包含明文 token 或密钥', !pv.json.html.includes(FAKE) && !pv.json.html.includes(cfg.gatewayKey));

    const clear = await request(base, {
      path: adminPath('/admin/api/notify/config'), method: 'PUT', body: { enabled: false, token: '' },
    });
    check('可清除已保存的推送 token',
      clear.status === 200 && clear.json.hasToken === false && !JSON.stringify(clear.json).includes(FAKE));
  }

  console.log('\n--- 第二阶段：注入一个永远 429 的假渠道，验证熔断与故障转移 ---\n');

  const broken = await startBrokenProvider();
  const fakeProvider = {
    id: '__broken__',
    name: '故意失败的渠道(429)',
    type: 'openai',
    baseUrl: `http://127.0.0.1:${broken.port}/v1`,
    enabled: true,
    keyless: true,
    priority: 99,
    rpm: 0,
    rpd: 0,
    keys: ['__keyless__'],
    models: [{ id: 'broken-model', alias: ['mock'], ctx: 4096, caps: ['chat'] }],
  };
  cfg.providers.push(fakeProvider);
  cfg.providerById.set(fakeProvider.id, fakeProvider);
  cfg.registry = buildRegistry(cfg.providers);
  ctx.pool.sync(cfg.providers);

  // 16. 故障转移：最高优先级的渠道 429，应自动落到内置模拟渠道
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'mock', messages: [{ role: 'user', content: '自检：故障转移' }] },
    });
    const g = (r.json && r.json.x_gateway) || {};
    check('首选渠道 429 时自动转移成功', r.status === 200 && g.provider === 'mock', `最终渠道 ${g.provider || '未知'}，共尝试 ${g.attempts} 次`);
    check('失败渠道被尝试过并记录为多次尝试', g.attempts >= 2, `尝试次数 ${g.attempts}`);
  }

  // 17. 熔断生效：失败渠道应进入冷却，不再被选中
  {
    const r = await request(base, { path: adminPath('/admin/api/overview') });
    const prov = (r.json.providers || []).find((p) => p.id === '__broken__');
    const st = prov && prov.keys[0];
    check('429 渠道已进入冷却熔断状态', !!(st && (st.status === 'cooldown' || st.status === 'limited')), st ? `${st.status}（剩余 ${Math.round((st.cooldownMsLeft || 0) / 1000)} 秒）` : '未找到');
  }

  // 18. 冷却后不再首选该渠道（自动路由回落到可用渠道）
  {
    const r = await request(base, {
      path: '/v1/chat/completions',
      method: 'POST',
      headers: auth,
      body: { model: 'mock', messages: [{ role: 'user', content: '自检：熔断后再请求' }] },
    });
    const g = (r.json && r.json.x_gateway) || {};
    check('熔断后直接命中可用渠道（无需重试）', r.status === 200 && g.provider === 'mock' && g.attempts === 1, `尝试 ${g.attempts} 次`);
  }

  // 19. 全部失败时的错误结构
  {
    const r = await request(base, {
      path: '/v1/models',
      headers: { Authorization: 'Bearer wrong-client-key' },
    });
    check('错误客户端密钥返回 401 与明确提示', r.status === 401 && !!r.json.error.code, `状态 ${r.status}`);
  }

  console.log('\n--- 第二点五阶段：配置备份与恢复（含加密） ---\n');

  // 备份会真实写回 4 份配置文件。先快照，测试完原样还原，绝不污染本机配置。
  const backupFiles = [
    cfg.paths.providersFile,
    cfg.paths.keysFile,
    path.join(cfg.paths.configDir, 'notify-config.json'),
    path.join(cfg.paths.configDir, 'update-config.json'),
  ];
  const backupSnapshot = backupFiles.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null));
  const restoreSnapshot = () => {
    backupFiles.forEach((f, i) => {
      try {
        if (backupSnapshot[i] === null) fs.rmSync(f, { force: true });
        else fs.writeFileSync(f, backupSnapshot[i], 'utf-8');
      } catch (_e) { /* 还原失败不掩盖测试结果 */ }
    });
  };

  {
    // 20. 明文导出：信封结构完整、含校验和、默认不含同意状态与网关密钥
    const exp = await request(base, {
      path: adminPath('/admin/api/backup/export'), method: 'POST', body: { secrets: true },
    });
    check('明文导出返回 200 与备份信封',
      exp.status === 200 && exp.json.ok && exp.json.backup && exp.json.backup.kind === 'free-model-gateway-backup',
      `状态 ${exp.status}`);
    check('明文备份包含 SHA-256 校验和与渠道数据',
      exp.json.backup.checksum && exp.json.backup.data && exp.json.backup.data.providers,
      `checksum ${exp.json.backup.checksum ? '存在' : '缺失'}`);
    check('备份不含用户协议状态与网关密钥',
      !exp.json.backup.data.eula && !exp.json.backup.data.gatewayKey,
      'eula / gatewayKey 未进备份');
    const filename = exp.json.filename || '';

    // 21. 明文恢复：先 preview（不落盘），再 apply
    const pv = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: exp.json.backup, preview: true },
    });
    check('恢复预览返回渠道与密钥摘要且不写盘',
      pv.status === 200 && pv.json.preview && typeof pv.json.summary.channels === 'number',
      `渠道 ${pv.json && pv.json.summary && pv.json.summary.channels}`);

    const ap = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: exp.json.backup },
    });
    check('恢复执行成功并写回配置文件',
      ap.status === 200 && Array.isArray(ap.json.applied.files) && ap.json.applied.files.includes('providers.json'),
      `写入 ${ap.json && ap.json.applied && ap.json.applied.files && ap.json.applied.files.join(',')}`);
    check('导出的文件名带时间戳且可作下载名', /^free-model-gateway-backup-\d{8}-\d{6}\.json$/.test(filename), filename);

    // 22. 加密导出 + 错误口令必须被拒绝
    const enc = await request(base, {
      path: adminPath('/admin/api/backup/export'), method: 'POST', body: { password: '自检口令abc123' },
    });
    check('加密导出返回加密信封（AES-256-GCM）',
      enc.status === 200 && enc.json.backup.encrypted === true && enc.json.backup.cipher === 'AES-256-GCM',
      `cipher ${enc.json.backup && enc.json.backup.cipher}`);
    check('加密备份不含明文 data 对象与校验和（data 是 base64 密文）',
      !enc.json.backup.checksum && typeof enc.json.backup.data === 'string'
      && !enc.json.backup.data.providers && !enc.json.backup.data.notify,
      '无 checksum，data 为密文字符串');

    const badPw = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: enc.json.backup, password: '绝对错误的口令' },
    });
    check('错误口令恢复被拒绝（400）',
      badPw.status === 400 && /口令/.test((badPw.json.error && badPw.json.error.message) || ''),
      badPw.json && badPw.json.error && badPw.json.error.message);

    // 23. 正确口令 + 缺口令的拒绝路径
    const okPw = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: enc.json.backup, password: '自检口令abc123', preview: true },
    });
    check('正确口令可解密并预览', okPw.status === 200 && okPw.json.preview && okPw.json.encrypted === true,
      `状态 ${okPw.status}`);
    const noPw = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: enc.json.backup, preview: true },
    });
    check('加密备份缺口令时提示输入口令',
      noPw.status === 400 && /口令/.test((noPw.json.error && noPw.json.error.message) || ''),
      noPw.json && noPw.json.error && noPw.json.error.message);

    // 24. 非本应用文件 / 篡改校验和必须被拒绝
    const alien = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: { kind: 'other-app-backup', data: {} } },
    });
    check('非本应用的备份文件被拒绝', alien.status === 400, `状态 ${alien.status}`);
    const tampered = JSON.parse(JSON.stringify(exp.json.backup));
    tampered.data.providers.providers = [];
    const tam = await request(base, {
      path: adminPath('/admin/api/backup/restore'), method: 'POST',
      body: { backup: tampered },
    });
    check('明文备份被篡改后校验和不匹配、拒绝恢复', tam.status === 400,
      (tam.json.error && tam.json.error.message) || `状态 ${tam.status}`);
  }

  broken.server.close();
  app.close();
  app.server.close();

  // 还原自检前的同意状态、推送配置与备份涉及的配置文件，避免污染开发者本机
  restoreSnapshot();
  if (!eulaAcceptedBefore) eula.revoke();
  if (notifyBefore === null) {
    try { fs.rmSync(NOTIFY_FILE, { force: true }); } catch (_e) { /* ignore */ }
  } else {
    try { fs.writeFileSync(NOTIFY_FILE, notifyBefore, 'utf-8'); } catch (_e) { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
  if (failed.length) {
    console.log('\n未通过项：');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exitCode = 1;
  } else {
    console.log('\n全链路自检通过：路由 / 鉴权 / 流式 / 故障转移 / 熔断 / 计量 / 大屏 全部正常。\n');
  }
}

main().catch((err) => {
  console.error('自检脚本异常：', err);
  process.exitCode = 1;
});
