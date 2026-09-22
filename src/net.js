'use strict';

/**
 * 与「谁在访问」有关的判定工具。
 *
 * 独立成一个模块是为了能在 selfcheck 里对纯函数做单元测试——
 * 鉴权这类安全逻辑必须逐条断言，而不是靠端到端顺带覆盖。
 */

/** 把 IPv4-mapped IPv6（::ffff:a.b.c.d）与大小写清理成可比较的形式 */
function normIp(ip) {
  return String(ip || '').replace(/^::ffff:/i, '').trim().toLowerCase();
}

/**
 * 是否属于私有网段（回环 / RFC1918 / 链路本地 / IPv6 ULA）。
 * 也就是「家里或办公室的内网」——网关默认把内网当作可信来源，
 * 因为 NAS 应用就是给同网段的主人用的；要关掉请设 GATEWAY_TRUST_LAN=0。
 */
function isPrivateLan(ip) {
  const s = normIp(ip);
  if (!s) return false;
  if (s === '::1' || s === 'localhost') return true;
  if (/^127\./.test(s)) return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  const m = s.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 ULA fc00::/7（fd00::/8 最常见）与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;
  return false;
}

/**
 * 是否来自「这台机器自己」：回环，或本机任一网卡的地址。
 *
 * 飞牛的桌面图标是用 `http://<NAS 自己的地址>:8790/` 打开的，源地址是 NAS
 * 本机的局域网 IP 而不是 127.0.0.1 —— 只认回环会让「点自己的桌面图标」
 * 也拿不到管理令牌。别的机器无法把源 IP 伪装成 NAS 自己的 IP，所以
 * 「本机网卡地址」同样可以视为本机。
 */
function isOwnAddress(ip) {
  const os = require('os');
  const raw = normIp(ip);
  if (!raw) return false;
  if (raw === '::1' || /^127\./.test(raw)) return true;
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (!addr || !addr.address) continue;
        if (normIp(addr.address) === raw) return true;
      }
    }
  } catch (_e) { /* 取不到网卡信息时退化为只认回环 */ }
  return false;
}

module.exports = { normIp, isPrivateLan, isOwnAddress };
