export const CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Config {
  port: number;
  /** Base URL of Relay's API, e.g. http://api:3000. */
  relayUrl: string;
  /** Sent to Relay as X-Api-Key when Relay has API_KEYS set. */
  relayApiKey: string | undefined;
  /** Keys accepted from callers in X-Api-Key. Empty = open (local only). */
  apiKeys: string[];
  allowedChannels: Channel[];
  maxBodyBytes: number;
  relayTimeoutMs: number;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function integer(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowed = list(env.ALLOWED_CHANNELS ?? CHANNELS.join(','));
  const unknown = allowed.filter((channel) => !(CHANNELS as readonly string[]).includes(channel));
  if (unknown.length > 0) throw new Error(`ALLOWED_CHANNELS has unknown channels: ${unknown.join(', ')}`);
  if (allowed.length === 0) throw new Error('ALLOWED_CHANNELS must list at least one channel');

  return {
    port: integer('PORT', 8080, env),
    relayUrl: (env.RELAY_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
    relayApiKey: env.RELAY_API_KEY || undefined,
    apiKeys: list(env.GATEWAY_API_KEYS),
    allowedChannels: allowed as Channel[],
    maxBodyBytes: integer('MAX_BODY_BYTES', 512 * 1024, env),
    relayTimeoutMs: integer('RELAY_TIMEOUT_MS', 5000, env),
  };
}
