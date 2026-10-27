import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { loadConfig, type Config } from './config';
import { createGateway } from './server';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const ID = '0190a3b2-7c1e-7d3a-9f10-1234567890ab';
let relay: Server;
let relayUrl: string;
let seen: Seen[];
let relayBehavior: (req: Seen) => {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

async function startGateway(overrides: Record<string, string> = {}): Promise<{ url: string; server: Server }> {
  const config: Config = loadConfig({ RELAY_URL: relayUrl, RELAY_TIMEOUT_MS: '300', ...overrides });
  const server = createGateway(config);
  return { url: await listen(server), server };
}

before(async () => {
  relay = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const call: Seen = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    seen.push(call);
    const answer = relayBehavior(call);
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    res.end(JSON.stringify(answer.body ?? {}));
  });
  relayUrl = await listen(relay);
});

after(() => relay.close());

beforeEach(() => {
  seen = [];
  relayBehavior = () => ({ status: 202, body: { id: ID, status: 'accepted' } });
});

const message = { channel: 'email', to: 'me@example.org', subject: 'Hello', body: 'It works' };

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('gateway: accepting a message', () => {
  it('hands the message to Relay and returns its 202', async () => {
    const { url, server } = await startGateway();
    const response = await post(url, { ...message, metadata: { campaign: 'welcome' } });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { id: ID, status: 'accepted' });
    assert.ok(response.headers.get('x-request-id'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.url, '/v1/messages');
    assert.deepEqual(JSON.parse(seen[0]?.body ?? ''), { ...message, metadata: { campaign: 'welcome' } });
    server.close();
  });

  it('forwards only the known fields', async () => {
    const { url, server } = await startGateway();
    await post(url, { ...message, admin: true, priority: 'high' });
    assert.deepEqual(JSON.parse(seen[0]?.body ?? ''), message);
    server.close();
  });

  it('forwards the Idempotency-Key and says when Relay replayed it', async () => {
    relayBehavior = () => ({
      status: 200,
      body: { id: ID, status: 'delivered' },
      headers: { 'idempotent-replayed': 'true' },
    });
    const { url, server } = await startGateway();
    const response = await post(url, message, { 'idempotency-key': 'signup-otp-42' });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('idempotent-replayed'), 'true');
    assert.equal(seen[0]?.headers['idempotency-key'], 'signup-otp-42');
    server.close();
  });

  it('passes Relay validation errors through unchanged', async () => {
    relayBehavior = () => ({
      status: 400,
      body: { message: 'invalid message', errors: ['to must be a valid e-mail address'] },
    });
    const { url, server } = await startGateway();
    const response = await post(url, { ...message, to: 'not-an-email' });

    assert.equal(response.status, 400);
    assert.deepEqual((await response.json()) as object, {
      message: 'invalid message',
      errors: ['to must be a valid e-mail address'],
    });
    server.close();
  });

  it('passes a 409 (same key, different message) through', async () => {
    relayBehavior = () => ({ status: 409, body: { message: 'Idempotency-Key already used' } });
    const { url, server } = await startGateway();
    assert.equal((await post(url, message, { 'idempotency-key': 'same-key-1' })).status, 409);
    server.close();
  });
});

describe('gateway: rejecting before Relay', () => {
  it('answers 400 for a body that is not JSON, without calling Relay', async () => {
    const { url, server } = await startGateway();
    const response = await post(url, '{not json');
    assert.equal(response.status, 400);
    assert.equal(seen.length, 0);
    server.close();
  });

  it('lists every problem in a bad request', async () => {
    const { url, server } = await startGateway();
    const response = await post(url, { channel: 'fax' });
    const body = (await response.json()) as { errors: string[] };

    assert.equal(response.status, 400);
    assert.equal(body.errors.length, 3);
    assert.equal(seen.length, 0);
    server.close();
  });

  it('refuses a channel that is not enabled', async () => {
    const { url, server } = await startGateway({ ALLOWED_CHANNELS: 'email' });
    const response = await post(url, { channel: 'sms', to: '+5571999999999', body: 'hi' });
    const body = (await response.json()) as { errors: string[] };

    assert.equal(response.status, 400);
    assert.match(body.errors[0] ?? '', /not enabled/);
    assert.equal(seen.length, 0);
    server.close();
  });

  it('refuses a body above the limit', async () => {
    const { url, server } = await startGateway({ MAX_BODY_BYTES: '200' });
    const response = await post(url, { ...message, body: 'x'.repeat(500) });
    assert.equal(response.status, 413);
    assert.equal(seen.length, 0);
    server.close();
  });

  it('answers 404 and 405 for other routes and methods', async () => {
    const { url, server } = await startGateway();
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/v1/messages`)).status, 405);
    server.close();
  });
});

describe('gateway: API keys', () => {
  it('requires a configured key and does not leak it to Relay', async () => {
    const { url, server } = await startGateway({ GATEWAY_API_KEYS: 'caller-key-1,caller-key-2' });

    assert.equal((await post(url, message)).status, 401);
    assert.equal((await post(url, message, { 'x-api-key': 'wrong' })).status, 401);
    assert.equal(seen.length, 0);

    assert.equal((await post(url, message, { 'x-api-key': 'caller-key-2' })).status, 202);
    assert.equal(seen[0]?.headers['x-api-key'], undefined);
    server.close();
  });

  it('presents its own key to Relay', async () => {
    const { url, server } = await startGateway({ RELAY_API_KEY: 'relay-secret' });
    await post(url, message);
    assert.equal(seen[0]?.headers['x-api-key'], 'relay-secret');
    server.close();
  });

  it('keeps the health probes open', async () => {
    const { url, server } = await startGateway({ GATEWAY_API_KEYS: 'caller-key-1' });
    assert.equal((await fetch(`${url}/health/live`)).status, 200);
    server.close();
  });
});

describe('gateway: when Relay misbehaves', () => {
  it('answers 502 when Relay rejects the gateway key, not the caller', async () => {
    relayBehavior = () => ({ status: 401, body: { message: 'missing or invalid X-Api-Key' } });
    const { url, server } = await startGateway();
    const response = await post(url, message);
    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /RELAY_API_KEY/);
    server.close();
  });

  it('answers 502 when Relay fails', async () => {
    relayBehavior = () => ({ status: 500 });
    const { url, server } = await startGateway();
    assert.equal((await post(url, message)).status, 502);
    server.close();
  });

  it('answers 504 when Relay is too slow', async () => {
    relayBehavior = () => ({ status: 202, body: { id: ID }, delayMs: 800 });
    const { url, server } = await startGateway();
    assert.equal((await post(url, message)).status, 504);
    server.close();
  });

  it('answers 502 when Relay cannot be reached', async () => {
    const { url, server } = await startGateway({ RELAY_URL: 'http://127.0.0.1:1' });
    assert.equal((await post(url, message)).status, 502);
    server.close();
  });
});

describe('gateway: reading a message and health', () => {
  it('proxies the status of a message', async () => {
    relayBehavior = () => ({ status: 200, body: { id: ID, status: 'delivered' } });
    const { url, server } = await startGateway();
    const response = await fetch(`${url}/v1/messages/${ID}`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: ID, status: 'delivered' });
    assert.equal(seen[0]?.url, `/v1/messages/${ID}`);
    server.close();
  });

  it('rejects an id that is not a UUID without calling Relay', async () => {
    const { url, server } = await startGateway();
    assert.equal((await fetch(`${url}/v1/messages/abc`)).status, 400);
    assert.equal(seen.length, 0);
    server.close();
  });

  it('passes a 404 through', async () => {
    relayBehavior = () => ({ status: 404, body: { message: 'Not Found' } });
    const { url, server } = await startGateway();
    assert.equal((await fetch(`${url}/v1/messages/${ID}`)).status, 404);
    server.close();
  });

  it('is ready only when Relay is', async () => {
    relayBehavior = () => ({ status: 200, body: { status: 'ok' } });
    const up = await startGateway();
    assert.equal((await fetch(`${up.url}/health/ready`)).status, 200);
    up.server.close();

    relayBehavior = () => ({ status: 503 });
    const down = await startGateway();
    assert.equal((await fetch(`${down.url}/health/ready`)).status, 503);
    down.server.close();
  });
});

describe('config', () => {
  it('rejects an unknown channel and a bad number', () => {
    assert.throws(() => loadConfig({ ALLOWED_CHANNELS: 'email,telegram' }), /unknown channels/);
    assert.throws(() => loadConfig({ PORT: 'abc' }), /positive integer/);
  });

  it('has safe defaults', () => {
    const config = loadConfig({});
    assert.equal(config.port, 8080);
    assert.equal(config.relayUrl, 'http://localhost:3000');
    assert.deepEqual(config.allowedChannels, ['email', 'sms', 'whatsapp', 'push']);
  });
});
