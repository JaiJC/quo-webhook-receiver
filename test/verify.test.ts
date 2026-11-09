import { describe, expect, it } from "vitest";
import { SignatureError, verifySignature } from "../src/verify.js";
import { SECRET, sign } from "./helpers.js";

const NOW = 1_800_000_000;
const body = JSON.stringify({ id: "EV1", type: "message.received" });
const headers = (over: Record<string, string> = {}) => ({
  id: "dlv_1",
  timestamp: String(NOW),
  signature: sign(body, "dlv_1", NOW),
  ...over,
});

describe("verifySignature", () => {
  it("accepts a correctly signed delivery", () => {
    expect(() => verifySignature(Buffer.from(body), headers(), SECRET, NOW)).not.toThrow();
  });

  it("rejects a tampered body", () => {
    expect(() => verifySignature(Buffer.from(body + " "), headers(), SECRET, NOW)).toThrow(SignatureError);
  });

  it("rejects re-serialized JSON, because the signature covers the raw bytes", () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(() => verifySignature(Buffer.from(pretty), headers(), SECRET, NOW)).toThrow(SignatureError);
  });

  it("rejects a wrong secret", () => {
    const other = "whsec_" + Buffer.from("another-secret").toString("base64");
    expect(() => verifySignature(Buffer.from(body), headers(), other, NOW)).toThrow(SignatureError);
  });

  it("rejects timestamps older than 5 minutes (replay) and far in the future", () => {
    const old = NOW - 301;
    expect(() =>
      verifySignature(Buffer.from(body), headers({ timestamp: String(old), signature: sign(body, "dlv_1", old) }), SECRET, NOW),
    ).toThrow(/timestamp/);
    const future = NOW + 301;
    expect(() =>
      verifySignature(Buffer.from(body), headers({ timestamp: String(future), signature: sign(body, "dlv_1", future) }), SECRET, NOW),
    ).toThrow(/timestamp/);
  });

  it("accepts when any one of several v1 signatures matches (key rotation)", () => {
    const sig = `v1,${Buffer.from("not-the-right-signature").toString("base64")} ${sign(body, "dlv_1", NOW)}`;
    expect(() => verifySignature(Buffer.from(body), headers({ signature: sig }), SECRET, NOW)).not.toThrow();
  });

  it("rejects missing headers and unknown signature versions", () => {
    expect(() => verifySignature(Buffer.from(body), { id: undefined, timestamp: undefined, signature: undefined }, SECRET, NOW)).toThrow(/Missing/);
    const v2 = sign(body, "dlv_1", NOW).replace("v1,", "v2,");
    expect(() => verifySignature(Buffer.from(body), headers({ signature: v2 }), SECRET, NOW)).toThrow(SignatureError);
  });
});

describe("compatibility with Svix, which Quo's docs recommend", () => {
  it("accepts a signature produced by the svix library", async () => {
    const { Webhook } = await import("svix");
    const ts = new Date(NOW * 1000);
    const sig = new Webhook(SECRET).sign("dlv_svix", ts, body);
    expect(() =>
      verifySignature(Buffer.from(body), { id: "dlv_svix", timestamp: String(NOW), signature: sig }, SECRET, NOW),
    ).not.toThrow();
  });

  it("produces a header that svix accepts for the same inputs", async () => {
    const { Webhook } = await import("svix");
    const headers = { "webhook-id": "dlv_1", "webhook-timestamp": String(NOW), "webhook-signature": sign(body, "dlv_1", NOW) };
    // svix checks the timestamp against the real clock, so sign "now" for this one.
    const real = Math.floor(Date.now() / 1000);
    headers["webhook-timestamp"] = String(real);
    headers["webhook-signature"] = sign(body, "dlv_1", real);
    expect(() => new Webhook(SECRET).verify(body, headers)).not.toThrow();
  });
});
