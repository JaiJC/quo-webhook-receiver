import express from "express";
import type { Queryable } from "./db.js";
import { handleEvent, type QuoEvent } from "./handler.js";
import { SignatureError, verifySignature } from "./verify.js";

export function createApp(db: Queryable, secret: string, now?: () => number) {
  const app = express();

  // express.raw keeps the exact bytes Quo signed. Parsing JSON first would break verification.
  app.post("/webhooks/quo", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) return res.status(400).json({ error: "Expected application/json" });

    const deliveryId = req.header("webhook-id");
    try {
      verifySignature(
        body,
        { id: deliveryId, timestamp: req.header("webhook-timestamp"), signature: req.header("webhook-signature") },
        secret,
        now?.(),
      );
    } catch (err) {
      if (err instanceof SignatureError) return res.status(401).json({ error: err.message });
      throw err;
    }

    let event: QuoEvent;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Malformed JSON" });
    }
    if (!event?.id || !event?.type || !event?.data) return res.status(400).json({ error: "Not a Quo event" });

    try {
      const outcome = await handleEvent(db, deliveryId!, event);
      return res.status(200).json({ outcome });
    } catch (err) {
      // Non-2xx on purpose: Quo retries (5s, 5m, 30m, 2h, 5h, 10h, 10h), so a brief DB blip loses nothing.
      console.error("handler failed", err);
      return res.status(500).json({ error: "Temporary failure" });
    }
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  return app;
}
