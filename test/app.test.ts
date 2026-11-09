import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SECRET, callEvent, makeDb, sign } from "./helpers.js";

const NOW = 1_800_000_000;
let db: Awaited<ReturnType<typeof makeDb>>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = await makeDb();
  app = createApp(db, SECRET, () => NOW);
});

afterEach(async () => {
  await db.end();
});

function deliver(event: object, deliveryId: string, opts: { sig?: string; ts?: number } = {}) {
  const raw = JSON.stringify(event);
  const ts = opts.ts ?? NOW;
  return request(app)
    .post("/webhooks/quo")
    .set("content-type", "application/json")
    .set("webhook-id", deliveryId)
    .set("webhook-timestamp", String(ts))
    .set("webhook-signature", opts.sig ?? sign(raw, deliveryId, ts))
    .send(raw);
}

const stored = async () => (await db.query("SELECT * FROM resources")).rows;
const deliveries = async () => (await db.query("SELECT * FROM webhook_deliveries")).rows;

describe("POST /webhooks/quo", () => {
  it("stores a validly signed event", async () => {
    const res = await deliver(callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z"), "dlv_1");
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("applied");
    expect(await stored()).toHaveLength(1);
  });

  it("returns 401 and stores nothing for a bad signature", async () => {
    const res = await deliver(callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z"), "dlv_1", {
      sig: "v1,AAAA",
    });
    expect(res.status).toBe(401);
    expect(await stored()).toHaveLength(0);
    expect(await deliveries()).toHaveLength(0);
  });

  it("processes a retried delivery once (same webhook-id)", async () => {
    const ev = callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z");
    const first = await deliver(ev, "dlv_1");
    const retry = await deliver(ev, "dlv_1");
    expect(first.body.outcome).toBe("applied");
    expect(retry.status).toBe(200); // ack, so Quo stops retrying
    expect(retry.body.outcome).toBe("duplicate");
    expect(await deliveries()).toHaveLength(1);
  });

  it("handles ten simultaneous copies of one delivery exactly once", async () => {
    const ev = callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z");
    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(ev, "dlv_race")));
    const outcomes = results.map((r) => r.body.outcome).sort();
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(outcomes.filter((o) => o === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(9);
    expect(await deliveries()).toHaveLength(1);
  });

  it("does not let an older event overwrite a newer one that arrived first", async () => {
    const newer = callEvent("EV2", "2026-04-13T12:05:00.000Z", "2026-04-13T12:05:00.000Z", { status: "completed" });
    const older = callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z", { status: "ringing" });
    expect((await deliver(newer, "dlv_new")).body.outcome).toBe("applied");
    const late = await deliver(older, "dlv_old");
    expect(late.status).toBe(200);
    expect(late.body.outcome).toBe("stale");
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload).data.resource.status).toBe("completed");
  });

  it("applies events in order normally (newer replaces older)", async () => {
    await deliver(callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z", { status: "ringing" }), "dlv_1");
    await deliver(callEvent("EV2", "2026-04-13T12:05:00.000Z", "2026-04-13T12:05:00.000Z", { status: "completed" }), "dlv_2");
    expect(JSON.parse((await stored())[0].payload).data.resource.status).toBe("completed");
  });

  it("keys summaries and transcripts by data.resource.callId so they attach to the same call", async () => {
    const summary = {
      id: "EV3",
      createdAt: "2026-04-13T12:10:00.000Z",
      type: "call.summary.completed",
      data: { resource: { callId: "AC9", createdAt: "2026-04-13T12:10:00.000Z" }, context: { orgId: "OR123" } },
    };
    await deliver(summary, "dlv_s");
    const rows = await stored();
    expect(rows[0].resource_id).toBe("AC9");
    expect(rows[0].kind).toBe("call");
  });

  it("returns 500 (so Quo retries) when the database fails, and the retry then succeeds", async () => {
    const ev = callEvent("EV1", "2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z");
    const realQuery = db.query.bind(db);
    let failures = 1;
    (db as any).query = (...args: unknown[]) => {
      if (failures-- > 0) return Promise.reject(new Error("connection reset"));
      return (realQuery as any)(...args);
    };
    expect((await deliver(ev, "dlv_1")).status).toBe(500);
    expect((await deliver(ev, "dlv_1")).body.outcome).toBe("applied");
  });

  it("returns 400 for a signed but malformed body", async () => {
    const raw = "not json";
    const res = await request(app)
      .post("/webhooks/quo")
      .set("content-type", "application/json")
      .set("webhook-id", "dlv_x")
      .set("webhook-timestamp", String(NOW))
      .set("webhook-signature", sign(raw, "dlv_x", NOW))
      .send(raw);
    expect(res.status).toBe(400);
  });
});
