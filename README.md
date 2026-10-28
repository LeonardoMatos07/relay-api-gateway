# relay-api-gateway

HTTP front door for [Relay](https://github.com/LeonardoMatos07/relay). A client sends one
request with the message, the recipient and the channel; the gateway authenticates it, checks
its shape and hands it to Relay, which stores it with its outbox row in one transaction and
delivers it through Kafka, the rate limiter and the providers.

```mermaid
flowchart LR
  client([Postman / client]) -- "POST /v1/messages<br/>X-Api-Key" --> gw[relay-api-gateway]
  gw -- "POST /v1/messages" --> relay[Relay API]
  relay -- "message + outbox row" --> pg[(PostgreSQL)]
  pg --> pub[publisher] --> kafka[[relay.&lt;channel&gt;]] --> worker[worker] --> ses[Amazon SES / Twilio]
```

## Why it does not write to Kafka itself

Relay's queue is fed through its API on purpose: the message row and the outbox row are written in
one transaction, the idempotency key is enforced there, and the workers update the message status in
that same table. A producer that wrote straight to the topic would skip all of that, and the worker
would have no row to update. So the gateway only forwards, and everything Relay guarantees
(`202` means committed, no lost message, no duplicates for the same key) still holds.

## API

`POST /v1/messages` with `X-Api-Key: <your key>`:

```json
{
  "channel": "email",
  "to": "someone@example.org",
  "subject": "Hello",
  "body": "The message",
  "metadata": { "campaign": "welcome" }
}
```

| Field       | Notes                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `channel`   | `email`, `sms`, `whatsapp` or `push`, limited to `ALLOWED_CHANNELS`                                                       |
| `to`        | E-mail address, E.164 phone (`+5571999999999`) or device token, by channel                                                |
| `subject`   | Required for `email`                                                                                                      |
| `body`      | Up to 4,000 characters                                                                                                    |
| `html`      | Optional, `email` only: the HTML part (the product's own template)                                                        |
| `variables` | Optional: values for `{{name}}` placeholders in `subject`, `body` and `html`; Relay renders them (HTML-escaped in `html`) |
| `metadata`  | Optional, up to 20 string values                                                                                          |

Optional header `Idempotency-Key` (8 to 128 characters): sending the same key and message again
returns the original message (`200` with `Idempotent-Replayed: true`); the same key with a different
message is a `409`.

| Status | Meaning                                                                              |
| ------ | ------------------------------------------------------------------------------------ |
| `202`  | Accepted: `{ "id": "...", "status": "accepted" }`                                    |
| `200`  | Same Idempotency-Key and message as before                                           |
| `400`  | Invalid message; `errors` lists every problem (the gateway's and Relay's own checks) |
| `401`  | Missing or wrong `X-Api-Key`                                                         |
| `409`  | Idempotency-Key already used for a different message                                 |
| `413`  | Body above `MAX_BODY_BYTES`                                                          |
| `502`  | Relay failed, is unreachable or rejected the gateway's own key                       |
| `504`  | Relay did not answer within `RELAY_TIMEOUT_MS`                                       |

`GET /v1/messages/{id}` returns the status (`accepted`, `delivered` or `failed`, attempts, last
error). `GET /health/live` and `GET /health/ready` (ready only when Relay is) need no key.

Every response carries `X-Request-Id`; send your own to correlate logs.

## Configuration

| Variable           | Default                 | Purpose                                                               |
| ------------------ | ----------------------- | --------------------------------------------------------------------- |
| `PORT`             | `8080`                  |                                                                       |
| `RELAY_URL`        | `http://localhost:3000` | Relay API (inside the compose network: `http://api:3000`)             |
| `RELAY_API_KEY`    | empty                   | Sent to Relay as `X-Api-Key` when Relay has `API_KEYS` set            |
| `GATEWAY_API_KEYS` | empty                   | Keys callers must send, comma separated. Empty accepts anyone (warns) |
| `ALLOWED_CHANNELS` | all four                | Channels accepted; set it to what your workers really deliver         |
| `MAX_BODY_BYTES`   | `524288`                |                                                                       |
| `RELAY_TIMEOUT_MS` | `5000`                  |                                                                       |

## Run

Start Relay first (`make up` in its repository, or at least `redpanda postgres redis migrate api
publisher worker`), then:

```bash
cp .env.example .env        # set GATEWAY_API_KEYS
docker compose up -d --build
curl -i localhost:8080/v1/messages \
  -H 'content-type: application/json' -H 'x-api-key: <your key>' \
  -d '{"channel":"email","to":"you@example.org","subject":"Hello","body":"It works"}'
```

Without Docker: `pnpm install && pnpm build && RELAY_URL=http://localhost:3000 pnpm start`.

To deliver real e-mail, Relay's workers need the SES provider
(`infra/terraform/ses` in the Relay repository). While the SES account is in the sandbox, both the
sender and the recipient must be verified identities.

## Develop

```bash
pnpm install
pnpm test          # 23 tests against an in-memory fake Relay
pnpm typecheck
pnpm format:check
```

No runtime dependencies: Node 22's `http` and `fetch`. Not covered here, by design: per-caller rate
limiting and TLS (put it behind an ingress or load balancer), which belong to the platform in front.
