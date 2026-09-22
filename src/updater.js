'use strict';

/**
 * 网关自带自动更新（零依赖）。
 *
 * 主通道：GitHub Releases。设置面板里填一个仓库（owner/repo）即可，
 * 网关会请求 GitHub 的 /releases/latest，比对 tag 版本，下载 Release 里附带的
 * free-model-gateway-<版本>.tgz，校验 sha256 后热替换 server/ ui/ manifest 并自重启。
 *
 * 高级通道（可选、默认折叠）：任意 update.json 地址（自建 update-server / OpenList / 镜像），
 * 作为 GitHub 拉不动时的备用源。
 *
 * 关键安全点：
 *   1. 凭据（GitHub 令牌 / Bearer / Basic）只存网关本机配置目录，前端仅回显「是否已配置」；
 *   2. 下载内容先查 gzip 魔数（0x1f 0x8b），拿到登录页 HTML 直接拦下不清解；
 *   3. 有 sha256 就校验；GitHub Release 资产取 API 自带的 digest（sha256:...），
 *      没有就尝试同名 .sha256 资产；
 *   4. 解包跳过 config/ 与 server/config/，绝不覆盖用户密钥与渠道配置；
 *   5. tar 解包做路径穿越防护（ensureWithin）。
 *
 * 布局兼容：
 *   - fnOS 部署：应用根目录含 manifest + server/ + ui/，更新包解开覆盖这三个即可；
 *   - 开发环境：无 manifest，自动更新会被安全拒绝（改源码即可），仅保留「检查更新」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const WIN = process.platform === 'win32';

// 默认更新源：本项目官方仓库。开箱即用，无需任何配置。
// （高级用户可在 config/update-config.json 里用 githubRepo 覆盖，或用 githubToken 提高 API 限额）
const DEFAULT_GITHUB_REPO = '373065025/free-model-gateway';

// ============================================================ 应用根目录

/**
 * 定位「应用根目录」——即内层更新包 app.tgz 解压落地的目录。
 *   - fnOS 部署：<APPDIR>/server/src/updater.js  → <APPDIR>（含 manifest + server/ + ui/）
 *   - 开发环境：<ROOT>/src/updater.js            → <ROOT>  （含 package.json + src/）
 */
function findAppRoot() {
  // 1) fnOS 布局：向上找到同时含 manifest 与 server/ 的目录
  for (let dir = __dirname, i = 0; i < 8; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, 'manifest')) && fs.existsSync(path.join(dir, 'server'))) return dir;
    } catch (_e) { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 2) 开发布局：向上找到同时含 package.json 与 src/ 的目录
  for (let dir = __dirname, i = 0; i < 8; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    } catch (_e) { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..');
}

const APP_ROOT = findAppRoot();
// 部署态：应用根目录带 manifest（fnOS 包解出来的样子）。开发态没有，禁止自替换。
const IS_DEPLOYED = fs.existsSync(path.join(APP_ROOT, 'manifest'));

let CFG = null;
let CONFIG_DIR = '';
let lastCheck = null;
let lastGoodSource = null;
let task = { state: 'idle', progress: 0, message: '', latest: '', error: '', finishedAt: 0 };

const updateConfigFile = () => path.join(CONFIG_DIR || APP_ROOT, 'update-config.json');

// ============================================================ 版本 / 源地址

function readUpdateConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(updateConfigFile(), 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_e) {
    return {};
  }
}

function getCurrentVersion() {
  for (const f of [path.join(APP_ROOT, 'manifest'), path.join(APP_ROOT, 'package.json')]) {
    try {
      const txt = fs.readFileSync(f, 'utf-8');
      if (f.endsWith('manifest')) {
        const m = txt.match(/^version\s*=\s*(.+)$/m);
        if (m) return m[1].trim();
      } else {
        const j = JSON.parse(txt);
        if (j.version) return String(j.version);
      }
    } catch (_e) { /* try next */ }
  }
  return '0.0.0';
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** 把各种 GitHub 仓库写法统一成 "owner/repo" */
function normalizeGitHubRepo(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const full = s.match(/github\.com[:/]+([^/\s#?]+)\/([^/\s#?]+)/i);
  if (full) return `${full[1]}/${full[2].replace(/\.git$/i, '')}`;
  const short = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (short) return `${short[1]}/${short[2].replace(/\.git$/i, '')}`;
  return '';
}

const githubApiUrl = (repo) => `https://api.github.com/repos/${repo}/releases/latest`;

// ---- 免令牌回退通道 -------------------------------------------------------
// api.github.com 匿名只有 60 次/小时/IP，共享出口 IP 很容易 403（实测踩到）。
// 而 github.com 的 /releases/latest 会 302 跳到具体 tag，不消耗 API 额度、
// 也不会被限流，因此作为主通道失败时的兜底：从 Location 解析版本号，
// 再按发布约定拼出资产地址与同名 .sha256。
// 注意：资产名约定必须与 .github/workflows/release.yml 保持一致。
const ASSET_NAME_PREFIX = 'free-model-gateway';
const DEFAULT_GITHUB_WEB_BASE = 'https://github.com';
const githubWebLatestUrl = (repo) => `${DEFAULT_GITHUB_WEB_BASE}/${repo}/releases/latest`;
const githubAssetUrl = (repo, tag, name, base) =>
  `${String(base || DEFAULT_GITHUB_WEB_BASE).replace(/\/+$/, '')}/${repo}/releases/download/${tag}/${name}`;

/** 从 302 的 Location（…/releases/tag/v1.2.1）里取出 tag */
function tagFromReleaseLocation(loc) {
  const m = String(loc || '').match(/\/releases\/tag\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

// ============================================================ 安全辅助

function looksLikeGzip(buf) {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** 把错误信息里的内网 IP / 端口抹掉，避免接口回显私有信息 */
function scrub(text) {
  return String(text || '').replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, '***');
}

// ============================================================ 更新源解析

/** 生效的仓库：配置里有就用配置的，否则用内置默认仓库 */
function effectiveRepo(s) {
  const cfg = s || readUpdateConfig();
  return normalizeGitHubRepo(cfg.githubRepo) || DEFAULT_GITHUB_REPO;
}

function resolveSources() {
  const s = readUpdateConfig();
  const repo = effectiveRepo(s);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'free-model-gateway' };
  const tok = String(s.githubToken || '').trim();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  return [
    // 主通道：GitHub API（元数据最全，配了令牌还能读私有仓库）
    { url: githubApiUrl(repo), label: `GitHub（${repo}）`, timeout: 15000, headers, kind: 'github', repo },
    // 兜底通道：github.com 直连，无需令牌、不受 API 限流（API 403 时自动接管）
    {
      url: githubWebLatestUrl(repo),
      label: `GitHub 网页（${repo}）`,
      timeout: 15000,
      headers: { 'User-Agent': 'free-model-gateway' },
      kind: 'github-web',
      repo,
      webBase: DEFAULT_GITHUB_WEB_BASE,
    },
  ];
}

// ============================================================ 网络

async function fetchWithTimeout(url, headers, timeout, redirect) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout || 15000);
  try {
    return await fetch(url, {
      headers: headers || {},
      signal: ctrl.signal,
      redirect: redirect || 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 免令牌通道：读 302 的 Location 拿版本，按约定拼资产地址，再取同名 .sha256 */
async function fetchManifestFromWeb(src) {
  const repo = src.repo || effectiveRepo();
  const webBase = String(src.webBase || DEFAULT_GITHUB_WEB_BASE).replace(/\/+$/, '');
  const timeout = src.timeout || 15000;
  const resp = await fetchWithTimeout(src.url, src.headers, timeout, 'manual');
  // redirect:'manual' 下拿到的就是 301/302/303/307/308；部分运行时会直接跟随后返回 200
  const loc = resp.headers.get('location') || resp.headers.get('Location') || '';
  let tag = tagFromReleaseLocation(loc);
  if (!tag) {
    // 兜底：有些环境会把重定向直接跟随掉，那就从最终 URL 里取 tag
    tag = tagFromReleaseLocation(resp.url || '');
  }
  if (!tag) {
    if (resp.status === 404) throw new Error('仓库没有已发布的 Release（404）');
    throw new Error(`未能从 GitHub 解析最新版本（HTTP ${resp.status}）`);
  }

  const version = tag.replace(/^v/, '');
  const name = `${ASSET_NAME_PREFIX}-${version}.tgz`;
  const url = githubAssetUrl(repo, tag, name, webBase);

  // sha256 走 CDN（不计 API 额度）；拿不到也不致命，下载后会验 gzip 魔数
  let sha256 = '';
  try {
    const r = await fetchWithTimeout(`${url}.sha256`, src.headers, timeout);
    if (r.ok) {
      const m = (await r.text()).match(/[a-f0-9]{64}/i);
      if (m) sha256 = m[0].toLowerCase();
    }
  } catch (_e) { /* 没有 .sha256 也能更新 */ }

  return {
    version,
    notes: '',
    url,
    size: 0,
    sha256,
    publishedAt: '',
    source: 'github-web',
  };
}

/** 从 GitHub Release 资产里拿 sha256（优先 API 自带 digest，其次同名 .sha256 资产） */
async function githubAssetSha(asset, assets, headers, timeout) {
  if (asset.digest && /^sha256:/i.test(asset.digest)) return asset.digest.split(':').pop().trim().toLowerCase();
  const side = (assets || []).find((a) => new RegExp(`^${asset.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.sha256$`, 'i').test(a.name));
  if (side && side.browser_download_url) {
    try {
      const r = await fetchWithTimeout(side.browser_download_url, headers, timeout);
      if (r.ok) {
        const t = await r.text();
        const m = t.match(/[a-f0-9]{64}/i);
        if (m) return m[0].toLowerCase();
      }
    } catch (_e) { /* ignore */ }
  }
  return '';
}

async function fetchManifest(src) {
  if (src.kind === 'github-web') return fetchManifestFromWeb(src);

  const h = Object.assign({ Accept: 'application/vnd.github+json', 'User-Agent': 'free-model-gateway' }, src.headers || {});
  const timeout = src.timeout || 15000;
  const resp = await fetchWithTimeout(src.url, h, timeout);
  if (!resp.ok) {
    if (resp.status === 404) throw new Error('更新源没有找到发布（404，仓库可能还没有 Release）');
    throw new Error(`更新清单拉取失败 HTTP ${resp.status}`);
  }
  const d = await resp.json();
  if (!d || typeof d !== 'object') throw new Error('更新清单不是合法 JSON');

  const assets = Array.isArray(d.assets) ? d.assets : [];
  const asset = assets.find((a) => /\.tgz$/i.test(a.name))
    || assets.find((a) => /\.fpk$/i.test(a.name))
    || assets[0];
  if (!asset) throw new Error('该 Release 没有可下载的资产（请在 Release 里附上 .tgz）');
  return {
    version: String(d.tag_name || '').replace(/^v/, ''),
    notes: String(d.body || '').slice(0, 3000),
    url: asset.browser_download_url,
    size: asset.size || 0,
    sha256: await githubAssetSha(asset, assets, h, timeout),
    publishedAt: d.published_at || '',
    source: 'github',
  };
}

// ============================================================ 检查更新

async function checkUpdate({ force = false } = {}) {
  const current = getCurrentVersion();
  const sources = resolveSources();

  if (!sources.length) {
    lastCheck = { at: Date.now(), hasUpdate: false, current, latest: current, disabled: true, notes: '' };
    return lastCheck;
  }
  if (!force && lastCheck && Date.now() - lastCheck.at < 30 * 60 * 1000) return lastCheck;

  const attempts = [];
  for (const src of sources) {
    try {
      const latest = await fetchManifest(src);
      lastCheck = {
        at: Date.now(),
        hasUpdate: cmpVersion(latest.version, current) > 0,
        current,
        disabled: false,
        latest: latest.version,
        notes: latest.notes,
        size: latest.size,
        publishedAt: latest.publishedAt,
        source: latest.source,
        sourceLabel: src.label,
        fallback: attempts.length,
        attempts,
      };
      lastGoodSource = src;
      return lastCheck;
    } catch (err) {
      attempts.push({ label: src.label, error: scrub(err.message) });
    }
  }

  lastGoodSource = null;
  lastCheck = {
    at: Date.now(), hasUpdate: false, current, latest: current, disabled: false, notes: '',
    error: '所有更新源都不可用：' + attempts.map((a) => `${a.label}（${a.error}）`).join('；'),
    attempts,
  };
  return lastCheck;
}

// ============================================================ 存储目录

function storageRoot() { return path.join(CONFIG_DIR || APP_ROOT, '.update'); }
function backupsDir() { return path.join(storageRoot(), 'backups'); }
function updatesDir() { return path.join(storageRoot(), 'downloads'); }

async function listBackups() {
  const dir = backupsDir();
  try {
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const i of items) {
      if (i.isDirectory() && fs.existsSync(path.join(dir, i.name, '.backup.json'))) out.push(i.name);
    }
    return out.sort((a, b) => cmpVersion(b, a));
  } catch (_e) {
    return [];
  }
}

async function isWritable(dir) {
  try { await fs.promises.access(dir, fs.constants.W_OK); return true; } catch (_e) { return false; }
}

// ============================================================ 下载

async function downloadFromSource(src) {
  const man = await fetchManifest(src);
  const resp = await fetchWithTimeout(man.url, src.headers, 300000);
  if (!resp.ok) throw new Error(`下载更新包失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('下载到的更新包为空');
  if (!looksLikeGzip(buf)) throw new Error('返回的不是更新包（鉴权失败或地址错误，疑似拿到登录页 HTML）');
  return { buf, man };
}

// ============================================================ 执行更新

async function performUpdate() {
  if (['downloading', 'verifying', 'installing', 'restarting'].includes(task.state)) {
    return { error: '已有更新任务在进行中' };
  }
  if (!IS_DEPLOYED) {
    return { error: '未检测到 fnOS 应用布局（应用根目录缺少 manifest）。开发模式请直接更新源码，或在应用中心升级。' };
  }
  const check = lastCheck && lastCheck.hasUpdate ? lastCheck : await checkUpdate({ force: true });
  if (!check || !check.hasUpdate) return { error: '当前已是最新版本' };

  const current = getCurrentVersion();
  task = { state: 'downloading', progress: 0, message: '正在下载更新包…', latest: check.latest, error: '', finishedAt: 0 };
  runUpdate(check, current).catch((err) => {
    task = Object.assign({}, task, { state: 'error', error: scrub(err.message), message: '更新失败', finishedAt: Date.now() });
  });
  return { started: true, version: check.latest };
}

/** 备份：把 server / ui / manifest 复制到备份目录（复制而非改名，跨文件系统也安全） */
async function backupCurrent(bDir) {
  await fs.promises.rm(bDir, { recursive: true, force: true });
  await fs.promises.mkdir(bDir, { recursive: true });
  const parts = [];
  for (const d of ['server', 'ui', 'manifest']) {
    const from = path.join(APP_ROOT, d);
    if (!fs.existsSync(from)) continue;
    await fs.promises.cp(from, path.join(bDir, d), { recursive: true, force: true });
    parts.push(d);
  }
  if (parts.length) {
    await fs.promises.writeFile(path.join(bDir, '.backup.json'), JSON.stringify({ version: getCurrentVersion(), at: Date.now(), parts }));
  }
  return parts;
}

/** 用备份覆盖回去 */
async function restoreFrom(bDir, parts) {
  for (const d of (parts && parts.length ? parts : ['server', 'ui', 'manifest'])) {
    const src = path.join(bDir, d);
    if (!fs.existsSync(src)) continue;
    const to = path.join(APP_ROOT, d);
    await fs.promises.rm(to, { recursive: true, force: true });
    await fs.promises.cp(src, to, { recursive: true, force: true });
  }
}

async function runUpdate(check, current) {
  const tmpDir = updatesDir();
  fs.mkdirSync(tmpDir, { recursive: true });

  const sources = resolveSources();
  const ordered = lastGoodSource ? [lastGoodSource, ...sources.filter((s) => s.url !== lastGoodSource.url)] : sources;

  let pkg = null;
  let latest = null;
  const errors = [];
  for (const src of ordered) {
    try {
      task = Object.assign({}, task, { message: `正在下载更新包…（${src.label}）` });
      const r = await downloadFromSource(src);
      pkg = r.buf;
      latest = r.man;
      break;
    } catch (err) {
      errors.push(`${src.label}：${scrub(err.message)}`);
      if (ordered.length > 1) task = Object.assign({}, task, { message: `${src.label}失败，正在换源重试…` });
    }
  }
  if (!pkg) throw new Error('所有更新源都下载失败 — ' + errors.join('；'));

  const file = path.join(tmpDir, `update-${latest.version}.tgz`);
  await fs.promises.writeFile(file, pkg);
  task = Object.assign({}, task, { state: 'verifying', progress: 45, latest: latest.version, message: '校验更新包…' });

  if (latest.sha256) {
    const sha = crypto.createHash('sha256').update(pkg).digest('hex');
    if (sha.toLowerCase() !== String(latest.sha256).toLowerCase()) {
      await fs.promises.rm(file, { force: true });
      throw new Error('校验失败：文件 SHA256 与更新清单不一致，已中止');
    }
  }

  if (!(await isWritable(APP_ROOT))) {
    throw new Error(`应用目录不可写：${APP_ROOT}（请检查应用权限，或改用应用中心手动升级）`);
  }

  task = Object.assign({}, task, { state: 'installing', progress: 60, message: '备份当前版本…' });
  const bDir = path.join(backupsDir(), current);
  const parts = await backupCurrent(bDir);

  task = Object.assign({}, task, { progress: 75, message: '安装新版本…' });
  try {
    extractTarGz(pkg, APP_ROOT, skipOnExtract);
  } catch (err) {
    try { await restoreFrom(bDir, parts); } catch (_e) { /* ignore */ }
    throw new Error('解包失败，已尝试回滚：' + err.message);
  }

  await fs.promises.rm(file, { force: true }).catch(() => {});

  task = Object.assign({}, task, { state: 'restarting', progress: 92, message: '正在重启应用…' });
  let restarted = false;
  let restartError = '';
  try { await restart(); restarted = true; } catch (err) { restartError = err.message; }

  if (restarted) {
    task = Object.assign({}, task, { state: 'done', progress: 100, message: '更新完成，正在重启…', finishedAt: Date.now() });
    setTimeout(() => process.exit(0), 1500);
  } else {
    task = Object.assign({}, task, { state: 'done', progress: 100, message: '新版本已安装，请手动重启应用', error: restartError, finishedAt: Date.now() });
  }
}

/** 解包时跳过用户配置，绝不覆盖密钥 / 渠道设置 */
function skipOnExtract(name) {
  const n = String(name).replace(/\\/g, '/');
  if (/^config\//.test(n) || /^server\/config\//.test(n)) return true;
  const base = n.split('/').pop();
  if (base === 'keys.json' || base === 'usage.json') return true;
  return false;
}

async function rollback(version) {
  const list = await listBackups();
  const target = version && list.includes(version) ? version : list[0];
  if (!target) return { error: '没有可回滚的备份' };

  const bDir = path.join(backupsDir(), target);
  let parts = null;
  try { parts = JSON.parse(fs.readFileSync(path.join(bDir, '.backup.json'), 'utf-8')).parts; } catch (_e) { parts = null; }

  await restoreFrom(bDir, parts);
  await fs.promises.rm(bDir, { recursive: true, force: true }).catch(() => {});

  let restarted = false;
  try { await restart(); restarted = true; } catch (_e) { /* ignore */ }
  if (restarted) setTimeout(() => process.exit(0), 1500);
  return { rolledBack: true, version: target, needManualRestart: !restarted };
}

/** 自重启：fork 一个脱离父进程的脚本，等本进程退出后重新拉起 node */
function restart() {
  return new Promise((resolve, reject) => {
    if (WIN) return reject(new Error('Windows 环境不支持自重启，请手动重启应用'));
    const serverDir = path.join(APP_ROOT, 'server');
    const node = process.execPath;
    const port = String((CFG && CFG.settings && CFG.settings.port) || process.env.GATEWAY_PORT || process.env.APP_PORT || '8790');
    const configDir = process.env.GATEWAY_CONFIG_DIR || '';
    const dataDir = process.env.GATEWAY_DATA_DIR || '';
    const host = process.env.GATEWAY_HOST || '0.0.0.0';
    const adminToken = process.env.GATEWAY_ADMIN_TOKEN || '';
    const log = path.join(storageRoot(), 'update.log');
    const pidFile = '/tmp/free-model-gateway.pid';
    const myPid = process.pid;

    const script = `
sleep 2
kill -9 ${myPid} 2>/dev/null
sleep 1
cd "${serverDir}"
export NODE_ENV=production
export GATEWAY_HOST="${host}"
export GATEWAY_PORT="${port}"
export GATEWAY_CONFIG_DIR="${configDir}"
export GATEWAY_DATA_DIR="${dataDir}"
export GATEWAY_ADMIN_TOKEN="${adminToken}"
nohup "${node}" src/index.js >> ${log} 2>&1 &
echo $! > ${pidFile}
`.trim();

    const child = spawn('/bin/sh', ['-c', script], {
      detached: true, stdio: 'ignore', cwd: serverDir, env: Object.assign({}, process.env),
    });
    child.on('error', reject);
    child.unref();
    resolve(true);
  });
}

// ============================================================ tar.gz 解包

function readString(buf, start, len) {
  let s = '';
  for (let i = 0; i < len; i += 1) {
    const c = buf[start + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function parseOctal(s) {
  s = s.trim();
  if (!s) return 0;
  if (s.charCodeAt(0) & 0x80) {
    let val = 0;
    for (let i = 1; i < s.length; i += 1) val = val * 256 + s.charCodeAt(i);
    return val;
  }
  return parseInt(s, 8) || 0;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    let j = i;
    while (j < buf.length && buf[j] !== 0x20) j += 1;
    const len = parseInt(buf.subarray(i, j).toString('utf8'), 10);
    if (!len || len <= 0) break;
    const record = buf.subarray(i, i + len).toString('utf8');
    const sp = record.indexOf(' ');
    const kv = sp >= 0 ? record.slice(sp + 1) : record;
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1).replace(/\n$/, '');
    i += len;
  }
  return out;
}

function ensureWithin(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw new Error('非法的压缩包路径（疑似路径穿越）：' + target);
  }
}

/** 把 .tgz 解包到 dest；isSkip(name) 返回 true 则跳过该条目 */
function extractTarGz(buf, dest, isSkip) {
  const data = zlib.gunzipSync(buf);
  let offset = 0;
  let longName = null;
  let pax = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header[0] === 0) break; // 结束块
    const name = readString(header, 0, 100);
    let size = parseOctal(readString(header, 124, 12));
    const typeflag = String.fromCharCode(header[156] || 0) || '0';
    offset += 512;

    let entryName = pax && pax.path ? pax.path : (longName || name);
    if (pax && pax.size) size = parseInt(pax.size, 10) || size;
    longName = null;
    pax = null;

    const contentStart = offset;
    offset += size + ((512 - (size % 512)) % 512);

    if (typeflag === 'L') {
      longName = data.subarray(contentStart, contentStart + size).toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      pax = parsePax(data.subarray(contentStart, contentStart + size));
      continue;
    }

    if (isSkip && isSkip(entryName)) continue;
    const target = path.join(dest, entryName);
    ensureWithin(dest, target);

    if (typeflag === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (typeflag === '0' || typeflag === '' || typeflag === '\0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data.subarray(contentStart, contentStart + size));
    }
  }
}

// ============================================================ 配置读写

async function saveUpdateConfig(patch) {
  const allowed = {};
  if (typeof patch.githubRepo === 'string') allowed.githubRepo = patch.githubRepo.trim();
  if (typeof patch.githubToken === 'string' && patch.githubToken.trim()) allowed.githubToken = patch.githubToken.trim();
  if (typeof patch.updateUrl === 'string') allowed.updateUrl = patch.updateUrl.trim();
  if (typeof patch.updateAltUrl === 'string') allowed.updateAltUrl = patch.updateAltUrl.trim();
  if (typeof patch.autoCheckUpdate === 'boolean') allowed.autoCheckUpdate = patch.autoCheckUpdate;
  if (typeof patch.updateToken === 'string' && patch.updateToken.trim()) allowed.updateToken = patch.updateToken.trim();
  if (typeof patch.updateUser === 'string') allowed.updateUser = patch.updateUser.trim();
  if (typeof patch.updatePassword === 'string' && patch.updatePassword) allowed.updatePassword = patch.updatePassword;

  const merged = Object.assign({}, readUpdateConfig(), allowed);
  fs.mkdirSync(CONFIG_DIR || APP_ROOT, { recursive: true });
  fs.writeFileSync(updateConfigFile(), JSON.stringify(merged, null, 2));
  lastCheck = null;
  lastGoodSource = null;
  return getUpdateConfig();
}

// ============================================================ 生命周期

function init(ctx) {
  CFG = ctx && ctx.cfg;
  CONFIG_DIR = (ctx && ctx.cfg && ctx.cfg.paths && ctx.cfg.paths.configDir) || APP_ROOT;
}

function startAutoUpdateCheck() {
  const tick = async () => {
    const s = readUpdateConfig();
    if (s.autoCheckUpdate === false) return;
    try { await checkUpdate({ force: true }); } catch (_e) { /* 静默 */ }
  };
  setTimeout(tick, 15000);
  setInterval(tick, 6 * 60 * 60 * 1000);
}

const getUpdateStatus = () => Object.assign({}, task);
const getLastCheck = () => lastCheck;
const getUpdateSources = () => resolveSources().map((s) => ({ label: s.label }));

/** 给前端回的更新配置摘要（绝不回发明文凭据） */
function getUpdateConfig() {
  const c = readUpdateConfig();
  return {
    githubRepo: c.githubRepo || '',
    hasGithubToken: !!c.githubToken,
    updateUrl: c.updateUrl || '',
    updateAltUrl: c.updateAltUrl || '',
    autoCheckUpdate: c.autoCheckUpdate !== false,
    hasToken: !!c.updateToken,
    hasBasic: !!(c.updateUser || c.updatePassword),
    deployed: IS_DEPLOYED,
    sources: resolveSources().map((s) => ({ label: s.label })),
  };
}

module.exports = {
  APP_ROOT,
  IS_DEPLOYED,
  init,
  getCurrentVersion,
  normalizeGitHubRepo,
  checkUpdate,
  performUpdate,
  getUpdateStatus,
  getLastCheck,
  listBackups,
  rollback,
  saveUpdateConfig,
  startAutoUpdateCheck,
  getUpdateSources,
  getUpdateConfig,
  looksLikeGzip,
  extractTarGz,
  // 供测试用的钩子（纯函数 + 网络函数，不参与运行时以外的逻辑）
  _internals: {
    cmpVersion, ensureWithin, skipOnExtract, findAppRoot,
    githubApiUrl, githubWebLatestUrl, githubAssetUrl, tagFromReleaseLocation, ASSET_NAME_PREFIX,
    storageRoot, fetchManifest, fetchManifestFromWeb, downloadFromSource, resolveSources,
  },
};
