# quo-webhook-receiver

A small TypeScript receiver for [Quo webhooks](https://www.quo.com/docs/2026-03-30/webhooks-overview). I built it to understand what the Connect side of an integration has to get right: untrusted input, retries, and events that arrive in the wrong order.

Express, `pg` and Vitest, with tests running against a real Postgres 16.

## What it does

`POST /webhooks/quo`

1. **Verifies the signature on the raw bytes.** HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw-body}`, base64 key from the `whsec_` secret, constant-time compare, 5 minute timestamp window, and any one of several `v1` entries may match (key rotation). A signed body that gets re-serialized no longer verifies, so the route uses `express.raw`, never `express.json`.
2. **Deduplicates on `webhook-id`**, not the envelope `id`. Quo retries on any non-2xx and `webhook-id` is stable across retries, while the envelope `id` is shared by every endpoint subscribed to the event.
3. **Ignores stale events.** Delivery order is not guaranteed, so a write only wins if its timestamp (`updatedAt`, else `createdAt`, else the envelope) is newer than what is stored.
4. **Returns 500 on its own failures**, so Quo's retry schedule (5s, 5m, 30m, 2h, 5h, 10h, 10h) covers a database blip. It returns 200 for duplicates and stale events, so Quo stops retrying them.

## Edge cases the tests pin down

- Tampered body, wrong secret, missing headers, unknown signature version
- Replayed (too old) and far-future timestamps
- Re-serialized JSON failing verification
- Compatibility with the `svix` library in both directions, since Quo's docs recommend it
- A retried delivery processed once
- Ten simultaneous copies of one delivery processed exactly once
- A newer event arriving first, then the older one: the older one is dropped
- Call summaries and transcripts attached to their call via `data.resource.callId`
- Database failure returns 500, and the retry then succeeds

## Design notes

- Idempotency and ordering live in SQL (`INSERT ... ON CONFLICT DO NOTHING RETURNING`, and an UPSERT with `WHERE EXCLUDED.occurred_at > resources.occurred_at`), so concurrent requests cannot race in application code.
- The delivery claim and the resource write are two statements, not one transaction. If the process dies between them, that delivery is acknowledged but unapplied. The fix is a single transaction or an outbox. I left it out to keep the example readable, and I would not ship it that way.
- I key a resource as `(kind, id)` with `kind` taken from the event prefix. That is an assumption to revisit against real payloads.

## Not done

- Not tested against live Quo traffic (no API key). The signature scheme follows their docs and is cross-checked against Svix. Payload handling uses only fields the docs name: `id`, `type`, `createdAt`, `data.resource.id`, `data.resource.callId`, `data.resource.updatedAt`, `data.context.orgId`.
- No per event-type schemas, no queue between receiver and processing, no metrics.

## Run it

```
npm install
cp .env.example .env        # QUO_WEBHOOK_KEY from POST /webhooks, DATABASE_URL
npm run dev                 # expose with ngrok or cloudflared, then POST /webhooks/events/test on Quo's side
TEST_DATABASE_URL=postgres://postgres@localhost:5432/quo_test npm test
```
