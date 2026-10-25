/**
 * Centralized configuration loader.
 * All environment variables are read once at startup and typed here.
 * Secrets are REQUIRED — the process refuses to start with missing or
 * placeholder values so a forgotten .env can never fall back to a known key.
 */

const PLACEHOLDERS = new Set([
  '',
  'dev-secret-change-me',
  'dev-key-change-me-16b',
  'changeme',
  'change-me',
  'secret',
  'password',
]);

function requireSecret(name: string, minLength: number): string {
  const value = (process.env[name] || '').trim();
  if (PLACEHOLDERS.has(value.toLowerCase()) || value.length < minLength) {
    // eslint-disable-next-line no-console
    console.error(
      `[config] ${name} is missing or too weak (need >= ${minLength} chars). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
    process.exit(1);
  }
  return value;
}

function parseOrigins(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const port = parseInt(process.env.PORT || '3000');
const appUrl = (process.env.APP_URL || `http://localhost:${isProduction ? 3080 : 5173}`).replace(/\/+$/, '');

export const config = {
  port,
  // Bind to loopback by default; inside Docker the container must listen on 0.0.0.0
  // (set HOST=0.0.0.0 there — docker-compose already does).
  host: process.env.HOST || '127.0.0.1',
  nodeEnv,
  isProduction,
  jwtSecret: requireSecret('JWT_SECRET', 32),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1d',
  encryptionKey: requireSecret('ENCRYPTION_KEY', 32),
  databaseUrl: process.env.DATABASE_URL || '',
  uploadDir: process.env.UPLOAD_DIR || '/var/lib/zalo-crm/files',
  appUrl,
  // Browser origins allowed for CORS + Socket.IO. APP_URL is always included;
  // add more with CORS_ORIGINS="https://a.example,https://b.example".
  allowedOrigins: Array.from(new Set([appUrl, ...parseOrigins(process.env.CORS_ORIGINS)])),
  // Public REST API (X-API-Key) can be switched off entirely.
  publicApiEnabled: (process.env.PUBLIC_API_ENABLED || 'true').toLowerCase() !== 'false',
  // Outbound webhooks can be switched off entirely.
  webhooksEnabled: (process.env.WEBHOOKS_ENABLED || 'true').toLowerCase() !== 'false',
  // Allow webhook targets on private/loopback networks (only for trusted LAN setups).
  webhookAllowPrivate: (process.env.WEBHOOK_ALLOW_PRIVATE || 'false').toLowerCase() === 'true',
};
