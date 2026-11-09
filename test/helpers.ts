import crypto from "node:crypto";
import pg from "pg";
import { SCHEMA } from "../src/db.js";

export const SECRET = "whsec_" + Buffer.from("test-secret-key-for-quo-webhooks").toString("base64");

export function sign(rawBody: string, id: string, timestamp: number, secret = SECRET): string {
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return `v1,${sig}`;
}

// Tests run against a real Postgres (UPSERT ... WHERE semantics are the point of the design).
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5432/quo_test";

export async function makeDb() {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  await pool.query(SCHEMA);
  await pool.query("TRUNCATE webhook_deliveries, resources");
  return pool;
}

export function callEvent(id: string, createdAt: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    apiVersion: "2026-03-30",
    createdAt,
    type: "call.completed",
    data: {
      resource: { id: "AC1", updatedAt, ...extra },
      context: { orgId: "OR123" },
      links: { quo: null },
    },
  };
}
