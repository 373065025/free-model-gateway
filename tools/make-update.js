#!/usr/bin/env node
'use strict';

/**
 * 生成「自动更新」所需的更新包 + 清单（本地打包辅助工具）。
 *
 * 复用 build_fpk.py 已经打好的内层 app.tgz（它本身就是热更新要覆盖的 server/ ui/ config/ manifest），
 * 只是另存为带版本号的名字，并算出 sha256 写入 update.json。
 *
 * 主通道是 GitHub Releases：推一个 v* 标签，.github/workflows/release.yml 会自动打包并发布
 * （附上 free-model-gateway-<版本>.tgz + .sha256 + .fpk）。网关侧只需在「自动更新」面板填 owner/repo。
 * 本脚本用于：本地预生成产物，或给「高级：自定义 / 镜像更新源」准备 update.json。
 *
 * 用法：
 *   node tools/make-update.js                       # 生成 build/update/{update.json, free-model-gateway-<版本>.tgz}
 *   node tools/make-update.js --notes "修复流式中断"
 *   node tools/make-update.js --publish              # 顺便推到自建 update-server（镜像源）
 *     --server https://update.example.com --token <ADMIN_TOKEN> --app free-model-gateway
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const FNOS = path.join(ROOT, 'fnos');
const BUILD = path.join(ROOT, 'build');
const OUT_DIR = path.join(BUILD, 'update');

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function readManifestVersion() {
  const txt = fs.readFileSync(path.join(FNOS, 'manifest'), 'utf-8');
  const m = txt.match(/^version\s*=\s*(.+)$/m);
  if (!m) throw new Error('无法从 fnos/manifest 读取版本号');
  return m[1].trim();
}

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

async function main() {
  const version = arg('version') || readManifestVersion();
  const notes = arg('notes') || '';
  const publish = process.argv.includes('--publish');

  const innerTgz = path.join(BUILD, 'app.tgz');
  if (!fs.existsSync(innerTgz)) {
    fail('找不到 build/app.tgz，请先运行 `npm run build:fpk` 生成内层包');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outName = `free-model-gateway-${version}.tgz`;
  const outFile = path.join(OUT_DIR, outName);
  fs.copyFileSync(innerTgz, outFile);

  const buf = fs.readFileSync(outFile);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const size = buf.length;

  const updateJson = {
    version,
    notes,
    publishedAt: new Date().toISOString().slice(0, 10),
    size,
    sha256: sha,
    url: outName, // 相对文件名：换域名/换端口无需重新发布
  };
  fs.writeFileSync(path.join(OUT_DIR, 'update.json'), JSON.stringify(updateJson, null, 2));

  console.log(`✓ 更新包：${outFile} (${(size / 1024).toFixed(1)} KB)`);
  console.log(`✓ update.json 已写入 ${path.join(OUT_DIR, 'update.json')}`);
  console.log(`  version  ${version}`);
  console.log(`  sha256   ${sha}`);
  console.log(`  url      ${outName}（相对路径）`);
  if (notes) console.log(`  notes    ${notes}`);

  if (publish) {
    await publishToServer(updateJson, outFile);
  } else {
    console.log('\n提示：把 update.json 与 ' + outName + ' 一起传到更新源即可。');
    console.log('      需要自动推送可加 --publish --server <地址> --token <ADMIN_TOKEN> --app free-model-gateway');
  }
}

async function publishToServer(meta, file) {
  const server = (arg('server') || process.env.UPDATE_SERVER || '').replace(/\/+$/, '');
  const token = arg('token') || process.env.ADMIN_TOKEN || '';
  const appId = arg('app') || process.env.UPDATE_APP || 'free-model-gateway';
  if (!server) fail('--publish 需要 --server 或环境变量 UPDATE_SERVER');
  if (!token) fail('--publish 需要 --token 或环境变量 ADMIN_TOKEN');

  const buf = fs.readFileSync(file);
  const url = new URL(`/${appId}/publish`, server);
  url.searchParams.set('version', meta.version);
  if (meta.notes) url.searchParams.set('notes', meta.notes);

  const resp = await fetch(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
    body: buf,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) fail(`发布失败 HTTP ${resp.status}：${data.error || text.slice(0, 300)}`);
  console.log(`✓ 已发布到更新源 ${server} / ${appId} (${meta.version})`);

  const appToken = arg('app-token') || process.env.APP_TOKEN || '';
  if (appToken) {
    const r = await fetch(`${server}/${appId}/update.json`, { headers: { Authorization: `Bearer ${appToken}` } });
    const j = await r.json().catch(() => ({}));
    console.log(`✓ 清单校验 HTTP ${r.status} → latest=${j.version}`);
  }
}

main().catch((e) => fail(e.message));
