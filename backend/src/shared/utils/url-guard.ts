/**
 * url-guard.ts — validates outbound webhook URLs to prevent SSRF.
 * Rejects non-http(s) schemes, credentials in URL, and hostnames that resolve
 * to loopback / private / link-local / metadata addresses (unless explicitly allowed).
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../../config/index.js';

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'db', 'app', 'backup']);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function inCidr4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return PRIVATE_V4.some((c) => inCidr4(ip, c));
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not an IP at all → treat as unsafe
}

/**
 * Throws an Error with a user-facing message if the URL is not a safe webhook target.
 * Returns the normalized URL string on success.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Webhook URL không hợp lệ');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Webhook URL phải dùng http:// hoặc https://');
  }
  if (url.username || url.password) {
    throw new Error('Webhook URL không được chứa thông tin đăng nhập');
  }
  if (config.webhookAllowPrivate) return url.toString();

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error('Webhook URL không được trỏ tới địa chỉ nội bộ');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Webhook URL không được trỏ tới địa chỉ nội bộ');
    return url.toString();
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error('Không phân giải được tên miền của webhook URL');
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('Webhook URL không được trỏ tới địa chỉ nội bộ');
  }
  return url.toString();
}
