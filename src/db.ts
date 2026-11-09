export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  text PRIMARY KEY,          -- webhook-id header, stable across retries
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (
  resource_id  text NOT NULL,
  kind         text NOT NULL,              -- "call", "message", "contact", ...
  org_id       text,
  occurred_at  timestamptz NOT NULL,       -- updatedAt, else createdAt, else envelope createdAt
  payload      text NOT NULL,
  PRIMARY KEY (kind, resource_id)
);
`;
