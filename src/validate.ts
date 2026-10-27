import { CHANNELS, type Channel } from './config';

export interface MessageRequest {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
  metadata?: Record<string, string>;
}

export type Validation = { ok: true; value: MessageRequest } | { ok: false; errors: string[] };

/**
 * Checks the shape of a request and the channel, so an obviously wrong call is answered here and
 * never reaches Relay. Recipient formats, sizes and the rest stay Relay's job (its validator is
 * the single source of truth and its error list is passed back unchanged), so the two cannot drift.
 */
export function validateRequest(input: unknown, allowedChannels: readonly Channel[]): Validation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];

  const channel = raw.channel;
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
    errors.push(`channel must be one of: ${CHANNELS.join(', ')}`);
  } else if (!allowedChannels.includes(channel as Channel)) {
    errors.push(`channel "${channel}" is not enabled here; enabled: ${allowedChannels.join(', ')}`);
  }
  if (typeof raw.to !== 'string' || raw.to.trim() === '') errors.push('to is required');
  if (typeof raw.body !== 'string' || raw.body.length === 0) errors.push('body is required');
  if (raw.subject !== undefined && typeof raw.subject !== 'string') errors.push('subject must be a string');
  if (raw.metadata !== undefined && (typeof raw.metadata !== 'object' || raw.metadata === null)) {
    errors.push('metadata must be an object of strings');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      channel: channel as Channel,
      to: (raw.to as string).trim(),
      body: raw.body as string,
      ...(raw.subject !== undefined ? { subject: raw.subject as string } : {}),
      ...(raw.metadata !== undefined ? { metadata: raw.metadata as Record<string, string> } : {}),
    },
  };
}
