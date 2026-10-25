/**
 * telegram-client.ts — minimal Telegram Bot API client (fetch, no dependency).
 * Only api.telegram.org is contacted; the token never leaves the server.
 */
const API = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

export async function tgCall<T = any>(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string; error_code?: number } | null;
  if (!data?.ok) {
    throw new TelegramError(data?.description || `Telegram HTTP ${res.status}`, data?.error_code ?? res.status);
  }
  return data.result as T;
}

/** Escape text for parse_mode=HTML. */
export function esc(text: unknown): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
