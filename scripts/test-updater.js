'use strict';

/**
 * 自动更新子系统单元测试（零依赖）。
 * 覆盖：版本比较、gzip 魔数、GitHub 仓库解析、跳过用户配置、路径穿越防护、
 *       tar 解包、以及用本地 mock GitHub API 跑通「清单解析 → 下载 → gzip 拦截」。
 *
 *   node scripts/test-updater.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const updater = require('../src/updater');
const {
  cmpVersion, ensureWithin, skipOnExtract,
  githubApiUrl, githubWebLatestUrl, githubAssetUrl, tagFromReleaseLocation, ASSET_NAME_PREFIX,
  fetchManifest, fetchManifestFromWeb, downloadFromSource, resolveSources,
} = updater._internals;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* --------------------------------------------------- 最小 tar 构建器（ustar） */
function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarHeader(name, size, typeflag, mode) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode || 0o644, 8), 100, 8, 'utf8');
  h.write(octal(0, 8), 108, 8, 'utf8');
  h.write(octal(0, 8), 116, 8, 'utf8');
  h.write(octal(size, 12), 124, 12, 'utf8');
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, 'utf8');
  h.write('        ', 148, 8, 'utf8'); // chksum 占位（空格）
  h.write(typeflag, 156, 1, 'utf8');
  h.write('ustar\0', 257, 6, 'utf8');
  h.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  h.write(octal(sum, 7), 148, 7, 'utf8');
  h[155] = 0x20;
  return h;
}

function makeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const content = Buffer.from(e.content || '', 'utf8');
    chunks.push(tarHeader(e.name, e.dir ? 0 : content.length, e.dir ? '5' : '0', e.dir ? 0o755 : 0o644));
    if (!e.dir) {
      chunks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0)); // 结束块
  return Buffer.concat(chunks);
}

const goodTar = zlib.gzipSync(makeTar([
  { name: 'server/', dir: true },
  { name: 'server/src/', dir: true },
  { name: 'server/src/index.js', content: 'NEW-CODE' },
  { name: 'server/config/keys.json', content: 'LEAKED-KEY' },
  { name: 'manifest', content: 'version = 9.9.9' },
]));

/* ------------------------------------------------------------------- 用例 */
async function main() {
  console.log('\n=== 自动更新子系统单元测试 ===\n');

  // 版本比较
  check('cmpVersion：1.2.0 > 1.1.0', cmpVersion('1.2.0', '1.1.0') === 1);
  check('cmpVersion：v1.2.0 == 1.2.0', cmpVersion('v1.2.0', '1.2.0') === 0);
  check('cmpVersion：1.0.0 < 1.0.1', cmpVersion('1.0.0', '1.0.1') === -1);
  check('cmpVersion：2.0 == 2.0.0', cmpVersion('2.0', '2.0.0') === 0);

  // gzip 魔数
  check('looksLikeGzip：识别 gzip 头', updater.looksLikeGzip(Buffer.from([0x1f, 0x8b, 0x08, 0x00])));
  check('looksLikeGzip：拒绝 HTML 登录页', !updater.looksLikeGzip(Buffer.from('<html>login</html>')));
  check('looksLikeGzip：拒绝空/过短', !updater.looksLikeGzip(Buffer.from([0x1f])));

  // GitHub 仓库解析
  check('normalizeGitHubRepo：owner/repo', updater.normalizeGitHubRepo('foo/bar') === 'foo/bar');
  check('normalizeGitHubRepo：完整 https URL', updater.normalizeGitHubRepo('https://github.com/foo/bar.git') === 'foo/bar');
  check('normalizeGitHubRepo：ssh 形式', updater.normalizeGitHubRepo('git@github.com:foo/bar.git') === 'foo/bar');
  check('normalizeGitHubRepo：空输入', updater.normalizeGitHubRepo('') === '');
  check('githubApiUrl：拼出 releases/latest', githubApiUrl('foo/bar') === 'https://api.github.com/repos/foo/bar/releases/latest');

  // ---- 免令牌回退通道的纯函数 ----
  check('tagFromReleaseLocation：从 302 Location 取 tag',
    tagFromReleaseLocation('https://github.com/foo/bar/releases/tag/v1.2.3') === 'v1.2.3');
  check('tagFromReleaseLocation：忽略查询串与 hash',
    tagFromReleaseLocation('https://github.com/foo/bar/releases/tag/v1.2.3?x=1#y') === 'v1.2.3');
  check('tagFromReleaseLocation：非法输入返回空',
    tagFromReleaseLocation('https://github.com/foo/bar/releases') === '');
  check('githubWebLatestUrl：拼出 releases/latest（网页）',
    githubWebLatestUrl('foo/bar') === 'https://github.com/foo/bar/releases/latest');
  check('githubAssetUrl：按约定拼资产地址',
    githubAssetUrl('foo/bar', 'v1.2.3', 'free-model-gateway-1.2.3.tgz')
      === 'https://github.com/foo/bar/releases/download/v1.2.3/free-model-gateway-1.2.3.tgz');
  check('资产前缀与发布约定一致',
    ASSET_NAME_PREFIX === 'free-model-gateway');

  // ---- 更新源列表：主通道 + 免令牌兜底 ----
  const srcList = resolveSources();
  check('更新源：主通道是 GitHub API', srcList[0].kind === 'github');
  check('更新源：第二个是免令牌网页兜底', srcList[1] && srcList[1].kind === 'github-web');
  check('更新源：默认仓库不依赖任何配置',
    srcList[0].label.includes('373065025/free-model-gateway'), srcList[0].label);
  check('更新源：兜底通道不带 Authorization',
    !srcList[1].headers.Authorization);

  // 跳过规则（保护用户配置）
  check('skipOnExtract：跳过 server/config/keys.json', skipOnExtract('server/config/keys.json') === true);
  check('skipOnExtract：跳过 server/config/providers.json', skipOnExtract('server/config/providers.json') === true);
  check('skipOnExtract：跳过 fnOS config/', skipOnExtract('config/privilege') === true);
  check('skipOnExtract：保留 server/src/index.js', skipOnExtract('server/src/index.js') === false);
  check('skipOnExtract：保留 manifest', skipOnExtract('manifest') === false);
  check('skipOnExtract：跳过后台任意 keys.json', skipOnExtract('whatever/keys.json') === true);

  // 路径穿越
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmg-upd-'));
  const dest = path.join(tmp, 'app');
  fs.mkdirSync(dest, { recursive: true });

  check('ensureWithin：拦截越界路径', (() => {
    try { ensureWithin(dest, path.join(dest, '..', 'evil')); return false; } catch (_e) { return true; }
  })());
  check('ensureWithin：放行内部路径', (() => {
    try { ensureWithin(dest, path.join(dest, 'a', 'b')); return true; } catch (_e) { return false; }
  })());

  // 解包 + 跳过
  fs.mkdirSync(path.join(dest, 'server', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'server', 'config', 'keys.json'), 'USER-KEY');

  updater.extractTarGz(goodTar, dest, skipOnExtract);
  check('解包：写出 server/src/index.js', fs.existsSync(path.join(dest, 'server/src/index.js')));
  check('解包：写出 manifest', fs.existsSync(path.join(dest, 'manifest')));
  check('解包：未用包内内容覆盖用户 keys.json',
    fs.readFileSync(path.join(dest, 'server', 'config', 'keys.json'), 'utf8') === 'USER-KEY');

  // 路径穿越 tar 必须抛错
  const badTar = zlib.gzipSync(makeTar([{ name: '../evil.txt', content: 'x' }]));
  let threw = false;
  try { updater.extractTarGz(badTar, dest, () => false); } catch (_e) { threw = true; }
  check('解包：路径穿越成员触发异常', threw);
  check('解包：穿越文件未落地', !fs.existsSync(path.join(tmp, 'evil.txt')));

  // 应用根目录
  check('findAppRoot：指向含 package.json 的目录（开发布局）', fs.existsSync(path.join(updater.APP_ROOT, 'package.json')));

  /* ---------------------------------------- mock GitHub API：跑通完整通道 */
  const sha = crypto.createHash('sha256').update(goodTar).digest('hex');
  let mockPort = 0;
  const mock = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${mockPort}`;
    if (req.url === '/repos/foo/bar/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v9.9.9',
        body: 'mock release notes',
        published_at: '2026-01-01T00:00:00Z',
        assets: [{
          name: 'free-model-gateway-9.9.9.tgz',
          browser_download_url: `${base}/dl/pkg.tgz`,
          size: goodTar.length,
          digest: `sha256:${sha}`,
        }],
      }));
    } else if (req.url === '/repos/foo/bar/releases/html') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v9.9.9',
        assets: [{ name: 'free-model-gateway-9.9.9.tgz', browser_download_url: `${base}/dl/login.html`, size: 30 }],
      }));
    } else if (req.url === '/dl/pkg.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(goodTar);
    } else if (req.url === '/dl/login.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>please login first</html>');
    } else if (req.url === '/foo/bar/releases/latest') {
      // 免令牌通道：302 跳到 tag
      res.writeHead(302, { Location: `${base}/foo/bar/releases/tag/v9.9.9` });
      res.end();
    } else if (req.url === '/foo/noside/releases/latest') {
      res.writeHead(302, { Location: `${base}/foo/noside/releases/tag/v9.9.9` });
      res.end();
    } else if (req.url === '/foo/empty/releases/latest') {
      res.writeHead(404);
      res.end('no releases here');
    } else if (req.url === '/foo/bar/releases/download/v9.9.9/free-model-gateway-9.9.9.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(goodTar);
    } else if (req.url === '/foo/bar/releases/download/v9.9.9/free-model-gateway-9.9.9.tgz.sha256') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${sha}  free-model-gateway-9.9.9.tgz\n`);
    } else if (req.url === '/foo/noside/releases/download/v9.9.9/free-model-gateway-9.9.9.tgz') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(goodTar);
    } else { res.writeHead(404); res.end('nope'); }
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', () => { mockPort = mock.address().port; r(); }));
  const base = `http://127.0.0.1:${mockPort}`;

  try {
    const ghSrc = { url: `${base}/repos/foo/bar/releases/latest`, kind: 'github', headers: {}, timeout: 5000 };
    const man = await fetchManifest(ghSrc);
    check('GitHub 清单：解析 tag 版本', man.version === '9.9.9', man.version);
    check('GitHub 清单：取到 sha256 digest', man.sha256 === sha, man.sha256.slice(0, 12) + '…');
    check('GitHub 清单：选中 .tgz 资产', /pkg\.tgz$/.test(man.url));
    check('GitHub 清单：notes 透传', man.notes === 'mock release notes');

    const dl = await downloadFromSource(ghSrc);
    check('GitHub 下载：拿到 gzip 包', updater.looksLikeGzip(dl.buf) && dl.buf.length === goodTar.length);

    // 登录页 HTML 必须被 gzip 魔数拦下
    let htmlThrew = false;
    try {
      await downloadFromSource({ url: `${base}/repos/foo/bar/releases/html`, kind: 'github', headers: {}, timeout: 5000 });
    } catch (_e) { htmlThrew = true; }
    check('GitHub 下载：登录页 HTML 被拦截', htmlThrew);

    // 404 → 友好报错
    let notFoundThrew = false;
    try {
      await downloadFromSource({ url: `${base}/repos/foo/bar/releases/missing`, kind: 'github', headers: {}, timeout: 5000 });
    } catch (_e) { notFoundThrew = true; }
    check('GitHub 清单：404 抛错', notFoundThrew);

    // ---------------- 免令牌回退通道（github.com 直连） ----------------
    const webSrc = {
      url: `${base}/foo/bar/releases/latest`,
      kind: 'github-web',
      repo: 'foo/bar',
      webBase: base,
      headers: { 'User-Agent': 'free-model-gateway' },
      timeout: 5000,
    };
    const webMan = await fetchManifest(webSrc);
    check('网页通道：从 302 解析出版本', webMan.version === '9.9.9', webMan.version);
    check('网页通道：按约定拼出资产地址',
      webMan.url === `${base}/foo/bar/releases/download/v9.9.9/free-model-gateway-9.9.9.tgz`, webMan.url);
    check('网页通道：从 .sha256 旁挂文件取到摘要', webMan.sha256 === sha, webMan.sha256.slice(0, 12) + '…');
    check('网页通道：标记 source=github-web', webMan.source === 'github-web');

    const webDl = await downloadFromSource(webSrc);
    check('网页通道：端到端下载并验到 gzip 包',
      updater.looksLikeGzip(webDl.buf) && webDl.buf.length === goodTar.length);

    // 缺少 .sha256 时不应致命（下载后还有 gzip 魔数兜底）
    const noSideMan = await fetchManifestFromWeb({
      url: `${base}/foo/noside/releases/latest`, kind: 'github-web', repo: 'foo/noside',
      webBase: base, headers: {}, timeout: 5000,
    });
    check('网页通道：缺 .sha256 时仍能解析（sha256 为空）',
      noSideMan.version === '9.9.9' && noSideMan.sha256 === '', `version=${noSideMan.version} sha256='${noSideMan.sha256}'`);

    // 仓库没有 Release → 说人话的 404
    let emptyThrew = '';
    try {
      await fetchManifestFromWeb({
        url: `${base}/foo/empty/releases/latest`, kind: 'github-web', repo: 'foo/empty',
        webBase: base, headers: {}, timeout: 5000,
      });
    } catch (err) { emptyThrew = err.message; }
    check('网页通道：无 Release 时给出可读报错', /404/.test(emptyThrew), emptyThrew);
  } finally {
    mock.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 项通过 ===`);
  if (failed.length) {
    console.log('\n未通过项：');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exitCode = 1;
  } else {
    console.log('\n自动更新子系统安全逻辑正常。\n');
  }
}

main().catch((err) => {
  console.error('测试异常：', err);
  process.exitCode = 1;
});
