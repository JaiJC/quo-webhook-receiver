import crypto from "node:crypto";

export const MAX_AGE_SECONDS = 5 * 60;

export class SignatureError extends Error {}

export interface WebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Verifies a Quo webhook delivery.
 * Signed content is `${webhook-id}.${webhook-timestamp}.${rawBody}` (HMAC-SHA256, base64),
 * and the key is the base64 part of the `whsec_...` secret.
 * `rawBody` must be the exact bytes Quo sent, not re-serialized JSON.
 */
export function verifySignature(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) {
    throw new SignatureError("Missing webhook headers");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) {
    throw new SignatureError("Stale or invalid timestamp");
  }

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = crypto
    .createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), rawBody]))
    .digest();

  // The header may hold several space-separated `v1,<sig>` entries (key rotation).
  const ok = signature
    .split(" ")
    .map((entry) => entry.trim().split(","))
    .some(([version, sig]) => {
      if (version !== "v1" || !sig) return false;
      const provided = Buffer.from(sig, "base64");
      return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    });

  if (!ok) throw new SignatureError("Invalid signature");
}
