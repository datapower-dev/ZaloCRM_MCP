/**
 * security-units.ts — quick self-checks for the hardening helpers.
 * Run:  cd backend && JWT_SECRET=<32+ chars> ENCRYPTION_KEY=<32+ chars> npx tsx test/security-units.ts
 * (no database needed)
 */
import assert from 'node:assert/strict';
import { encryptJson, decryptJson, isEncryptedBlob, sha256Hex, safeEqual } from '../src/shared/utils/crypto.js';
import { isPrivateIp, assertSafeWebhookUrl } from '../src/shared/utils/url-guard.js';
import { validatePassword } from '../src/modules/auth/password-policy.js';
import { parseSession, serializeSession, isLegacyPlaintext } from '../src/modules/zalo/zalo-session.js';

async function main() {
  // ── crypto ──────────────────────────────────────────────────────────────────
  const creds = { cookie: [{ name: 'zpsid', value: 'abc' }], imei: 'imei-123', userAgent: 'UA' };
  const blob = encryptJson(creds);
  assert.ok(isEncryptedBlob(blob));
  assert.ok(!JSON.stringify(blob).includes('imei-123'), 'ciphertext must not contain plaintext');
  assert.deepEqual(decryptJson(blob), creds);
  const tampered = { ...blob, data: blob.data.slice(0, -4) + 'AAAA' };
  assert.throws(() => decryptJson(tampered), 'tampered ciphertext must fail auth');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(safeEqual('x', 'x') && !safeEqual('x', 'y') && !safeEqual('x', 'xx'));

  // ── session (de)serialization incl. legacy plaintext ────────────────────────
  const stored = serializeSession(creds);
  assert.ok(isEncryptedBlob(stored));
  assert.deepEqual(parseSession(stored), creds);
  assert.ok(isLegacyPlaintext(creds));
  assert.deepEqual(parseSession(creds), creds, 'legacy plaintext still readable');
  assert.equal(parseSession(null), null);
  assert.equal(parseSession({ foo: 1 }), null);

  // ── SSRF guard ──────────────────────────────────────────────────────────────
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fe80::1']) {
    assert.ok(isPrivateIp(ip), `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.ok(!isPrivateIp(ip), `${ip} should be public`);
  }
  for (const bad of [
    'ftp://example.com/x',
    'http://user:pw@example.com/x',
    'http://localhost:3000/hook',
    'http://127.0.0.1/hook',
    'http://[::1]/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://db:5432/',
    'not a url',
  ]) {
    await assert.rejects(assertSafeWebhookUrl(bad), `${bad} must be rejected`);
  }
  assert.equal(await assertSafeWebhookUrl('https://1.1.1.1/hook'), 'https://1.1.1.1/hook');

  // ── password policy ─────────────────────────────────────────────────────────
  assert.ok(validatePassword('short1'));
  assert.ok(validatePassword('onlyletters'));
  assert.ok(validatePassword('12345678'));
  assert.equal(validatePassword('Matkhau2026'), null);

  console.log('security-units: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
