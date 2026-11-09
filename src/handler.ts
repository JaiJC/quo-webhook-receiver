import type { Queryable } from "./db.js";

export interface QuoEvent {
  id: string;
  apiVersion?: string;
  createdAt: string;
  type: string;
  data: {
    resource?: Record<string, any>;
    context?: { orgId?: string } & Record<string, any>;
    links?: { quo?: string | null };
  };
}

export type Outcome = "applied" | "stale" | "duplicate";

/** "call.summary.completed" -> "call". */
const kindOf = (type: string) => type.split(".")[0] ?? type;

/**
 * Docs: summaries, transcripts and voicemails identify the call with `callId`;
 * other payloads use `id`. Treat ids as opaque strings.
 */
function resourceId(event: QuoEvent): string | undefined {
  const r = event.data.resource;
  return r?.callId ?? r?.id;
}

/** Freshness clock for ordering: updatedAt, then createdAt, then the envelope. */
function occurredAt(event: QuoEvent): string {
  const r = event.data.resource;
  return r?.updatedAt ?? r?.createdAt ?? event.createdAt;
}

/**
 * Records one delivery exactly once, and only lets fresher data overwrite older data.
 *
 * - Idempotency: the delivery row is inserted first. Quo retries on any non-2xx and
 *   `webhook-id` is stable across retries, so a conflict means "already handled".
 * - Ordering: Quo does not guarantee order, so a write only wins if its timestamp is
 *   newer than what is stored (checked inside the UPSERT, so concurrent requests are safe).
 */
export async function handleEvent(
  db: Queryable,
  deliveryId: string,
  event: QuoEvent,
): Promise<Outcome> {
  const claimed = await db.query(
    `INSERT INTO webhook_deliveries (delivery_id, event_id, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (delivery_id) DO NOTHING
     RETURNING delivery_id`,
    [deliveryId, event.id, event.type],
  );
  if (claimed.rows.length === 0) return "duplicate";

  const rid = resourceId(event);
  if (!rid) return "applied"; // nothing to store, delivery is still recorded

  const written = await db.query(
    `INSERT INTO resources (resource_id, kind, org_id, occurred_at, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, resource_id) DO UPDATE
       SET occurred_at = EXCLUDED.occurred_at,
           payload     = EXCLUDED.payload,
           org_id      = EXCLUDED.org_id
       WHERE EXCLUDED.occurred_at > resources.occurred_at
     RETURNING resource_id`,
    [rid, kindOf(event.type), event.data.context?.orgId ?? null, occurredAt(event), JSON.stringify(event)],
  );
  return written.rows.length === 0 ? "stale" : "applied";
}
