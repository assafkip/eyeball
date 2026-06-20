/* ═══════════════════════════════════════════════════════════════════════════
   eyeball-web — lib/guard.mjs : SSRF guard for the public render endpoint.

   A "render any URL" service must never reach internal/cloud-metadata hosts. A
   host-string check is not enough: IPs hide in decimal/octal/hex/IPv6 forms, and
   DNS can resolve a name to a private address. This module rejects all of those.
   It is PURE (the DNS resolver is injected) so it is unit-tested with a stub.

   The render engine ALSO intercepts every browser request with the same blocklist
   (defense in depth: redirects, subresources, rebinding). This is layer one.
   ═══════════════════════════════════════════════════════════════════════════ */

export class BlockedUrlError extends Error {
  constructor(message) { super(message); this.name = "BlockedUrlError"; this.blocked = true; }
}

/* inet_aton-style parse of an IPv4 literal in dotted/decimal/octal/hex forms.
   Returns canonical "a.b.c.d" or null if the host is not a numeric IPv4 literal. */
export function parseIpv4Loose(host) {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (p === "") return null;
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const k = nums.length;
  let value;
  if (k === 1) {
    value = nums[0];
    if (value > 0xffffffff) return null;
  } else {
    for (let i = 0; i < k - 1; i++) if (nums[i] > 255) return null;
    const last = nums[k - 1];
    if (last >= Math.pow(256, 4 - (k - 1))) return null;
    value = last;
    for (let i = 0; i < k - 1; i++) value += nums[i] * Math.pow(256, 3 - i);
  }
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function isBlockedIpv4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true; // malformed -> block
  const [a, b] = o;
  if (a === 0) return true;                       // 0.0.0.0/8 "this host"
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                        // multicast / reserved
  return false;
}

function isBlockedIpv6(ip) {
  const x = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped/embedded forms -> classify as the embedded IPv4 (dotted or hex).
  const dotted = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isBlockedIpv4(dotted[1]);
  const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return isBlockedIpv4([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join("."));
  }
  // DEFAULT-DENY: only global-unicast 2000::/3 is a candidate; everything else
  // (loopback ::1, ULA fc/fd, link-local fe80, multicast ff, discard 100::,
  // NAT64 64:ff9b, etc. all have a first hextet outside 2000-3fff) is blocked.
  const first = parseInt(x.split(":")[0] || "0", 16) || 0;
  if (first < 0x2000 || first > 0x3fff) return true;
  if (x.startsWith("2001:db8")) return true;        // documentation
  if (x.startsWith("2002:")) return true;           // 6to4 (embeds arbitrary v4)
  if (x.startsWith("2001:0000") || /^2001:0:/.test(x)) return true; // teredo
  return false;
}

export function isBlockedIp(ip) {
  if (!ip) return true;
  const s = String(ip).replace(/^\[|\]$/g, "");
  if (s.includes(":")) return isBlockedIpv6(s);
  return isBlockedIpv4(s);
}

/* parse a host into IP addresses IF it is an IP literal (any encoding); else null
   (it is a DNS name and must be resolved). */
function ipLiteral(host) {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes(":")) return [h];                  // IPv6 literal
  const v4 = parseIpv4Loose(h);
  return v4 ? [v4] : null;
}

/**
 * Throw BlockedUrlError unless `rawUrl` is a public http(s) URL.
 * @param {string} rawUrl
 * @param {(host:string)=>Promise<string[]>} resolve  resolves a DNS name to all A/AAAA addresses
 * @returns {Promise<{host:string, ips:string[]}>}
 */
export async function assertPublicUrl(rawUrl, resolve) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new BlockedUrlError("not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError("only http and https URLs are allowed");
  const host = u.hostname;
  if (!host) throw new BlockedUrlError("missing host");

  const literal = ipLiteral(host);
  if (literal) {
    // MVP: IPv6 literals are rejected. Exhaustive IPv6 special-range classification
    // (mapped/translated/6to4/NAT64/doc/ULA...) is a pre-public-launch item; blocking
    // IPv6 outright keeps the blocklist complete instead of partial.
    if (literal.some((ip) => ip.includes(":"))) throw new BlockedUrlError("IPv6 addresses are not supported yet");
    for (const ip of literal) if (isBlockedIp(ip)) throw new BlockedUrlError(`blocked address: ${ip}`);
    return { host, ips: literal };
  }
  if (/^(localhost|.*\.localhost)$/i.test(host)) throw new BlockedUrlError("blocked host: localhost");

  const records = await resolve(host);
  const all = (records || []).map((r) => (typeof r === "string" ? r : r.address)).filter(Boolean);
  if (!all.length) throw new BlockedUrlError("host did not resolve");
  // Check EVERY resolved address (A AND AAAA): a host with a public A but a private
  // AAAA must be blocked, because a (subresource) request could reach the AAAA.
  for (const ip of all) if (isBlockedIp(ip)) throw new BlockedUrlError(`host resolves to a blocked address: ${ip}`);
  // We render over IPv4 (we pin the main host to it); require a public IPv4 exists.
  const ipv4 = all.filter((ip) => !ip.includes(":"));
  if (!ipv4.length) throw new BlockedUrlError("host has no allowed IPv4 address (IPv6-only is not supported yet)");
  return { host, ips: ipv4 };
}

/* convenience for the engine's per-request interception: true = block this host. */
export async function hostIsBlocked(host, resolve) {
  try { await assertPublicUrl("http://" + host, resolve); return false; }
  catch { return true; }
}
