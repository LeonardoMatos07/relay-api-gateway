import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Config } from './config';
import { validateRequest } from './validate';

type Fetch = typeof fetch;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `body must be at most ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function authorized(req: IncomingMessage, keys: Buffer[]): boolean {
  if (keys.length === 0) return true;
  const given = req.headers['x-api-key'];
  if (typeof given !== 'string' || given === '') return false;
  const candidate = Buffer.from(given);
  return keys.some((key) => key.length === candidate.length && timingSafeEqual(key, candidate));
}

export function createGateway(config: Config, fetchImpl: Fetch = fetch): Server {
  const keys = config.apiKeys.map((key) => Buffer.from(key));

  async function callRelay(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (config.relayApiKey) headers.set('x-api-key', config.relayApiKey);
    try {
      return await fetchImpl(`${config.relayUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(config.relayTimeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new HttpError(timedOut ? 504 : 502, timedOut ? 'relay did not answer in time' : 'relay is unreachable');
    }
  }

  /** Relay answers JSON; whatever it says about the message is passed on, but its own auth errors are ours. */
  async function relayAnswer(response: Response, requestId: string, res: ServerResponse): Promise<void> {
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, 'the gateway is not authorized by relay (check RELAY_API_KEY)');
    }
    if (response.status >= 500) throw new HttpError(502, `relay failed with status ${response.status}`);
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(502, 'relay sent an invalid response');
    }
    const headers: Record<string, string> = { 'x-request-id': requestId };
    const replayed = response.headers.get('idempotent-replayed');
    if (replayed) headers['idempotent-replayed'] = replayed;
    send(res, response.status, body, headers);
  }

  async function route(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health/live') return send(res, 200, { status: 'ok' });
    if (method === 'GET' && path === '/health/ready') {
      const relay = await callRelay('/health/ready');
      if (!relay.ok) throw new HttpError(503, 'relay is not ready');
      return send(res, 200, { status: 'ok' });
    }

    if (!authorized(req, keys)) throw new HttpError(401, 'missing or invalid X-Api-Key');

    if (path === '/v1/messages') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      const raw = await readBody(req, config.maxBodyBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HttpError(400, 'body must be valid JSON');
      }
      const validation = validateRequest(parsed, config.allowedChannels);
      if (!validation.ok) throw new HttpError(400, 'invalid message', { errors: validation.errors });

      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey === 'string') headers['idempotency-key'] = idempotencyKey;
      const response = await callRelay('/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(validation.value),
      });
      return relayAnswer(response, requestId, res);
    }

    const match = /^\/v1\/messages\/([^/]+)$/.exec(path);
    if (match) {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      const id = match[1] ?? '';
      if (!UUID.test(id)) throw new HttpError(400, 'id must be a UUID');
      return relayAnswer(await callRelay(`/v1/messages/${id}`), requestId, res);
    }

    throw new HttpError(404, 'not found');
  }

  return createServer((req, res) => {
    const started = Date.now();
    const requestId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) || randomUUID();
    res.on('finish', () => {
      console.log(
        JSON.stringify({
          level: 'info',
          msg: 'request',
          requestId,
          method: req.method,
          path: req.url?.split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      );
    });
    route(req, res, requestId).catch((error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof HttpError) {
        send(res, error.status, { error: error.message, requestId, ...error.extra }, { 'x-request-id': requestId });
        return;
      }
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled', requestId, error: String(error) }));
      send(res, 500, { error: 'internal error', requestId }, { 'x-request-id': requestId });
    });
  });
}
