import { describe, expect, it } from "vitest";
import { verifyTokenMatches, verifyWebhookSignature } from "../src/integrations/whatsapp/signature";
import { harness, rows, TEST_APP_SECRET, TEST_VERIFY_TOKEN, testEnv } from "./helpers/harness";
import { newPhone, seedStore } from "./helpers/seed";
import { signBody, textMessage, wamid, webhook } from "./helpers/whatsapp";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).buffer as ArrayBuffer;

async function storeWithOwner() {
  const phone = newPhone();
  const store = await seedStore({ members: [{ phone, role: "owner" }] });
  return { store, phone };
}

function messageFor(phoneNumberId: string, from: string, id = wamid()) {
  return webhook(phoneNumberId, { messages: [textMessage({ from, id, timestampS: 1_793_196_000, body: "Hola" })] });
}

async function inboundCount(businessId: string): Promise<number> {
  const [row] = await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages WHERE business_id = ?1`, businessId);
  return row?.n ?? 0;
}

describe("X-Hub-Signature-256", () => {
  it("accepts a body signed with the app secret", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const response = await h.post(messageFor(store.phoneNumberId, phone));
    expect(response.status).toBe(200);
    expect(await inboundCount(store.businessId)).toBe(1);
  });

  it("rejects a body signed with another secret", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const raw = JSON.stringify(messageFor(store.phoneNumberId, phone));
    const response = await h.post(raw, await signBody("some-other-secret", raw));
    expect(response.status).toBe(401);
    expect(await inboundCount(store.businessId)).toBe(0);
  });

  it("rejects a missing or malformed header", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const raw = JSON.stringify(messageFor(store.phoneNumberId, phone));
    const valid = await signBody(TEST_APP_SECRET, raw);
    for (const header of [null, "", valid.slice("sha256=".length), `sha1=${valid.slice(7)}`, `${valid}00`, "sha256=zz"]) {
      expect((await h.post(raw, header)).status).toBe(401);
    }
    expect(await inboundCount(store.businessId)).toBe(0);
  });

  it("covers the raw bytes: re-serialized JSON with the same meaning fails", async () => {
    const h = harness();
    const { store, phone } = await storeWithOwner();
    const raw = JSON.stringify(messageFor(store.phoneNumberId, phone));
    const signature = await signBody(TEST_APP_SECRET, raw);
    const reformatted = JSON.stringify(JSON.parse(raw), null, 2);
    expect((await h.post(reformatted, signature)).status).toBe(401);
    expect(await inboundCount(store.businessId)).toBe(0);
  });

  it("checks the signature before parsing: a bad signature on invalid JSON is 401, not 400", async () => {
    const h = harness();
    expect((await h.post("{not json", "sha256=" + "0".repeat(64))).status).toBe(401);
    expect((await h.post("{not json")).status).toBe(400);
  });

  it("never passes with an empty app secret, even when the body is signed with an empty key", async () => {
    const h = harness({ env: testEnv({ WHATSAPP_APP_SECRET: "" }) });
    const { store, phone } = await storeWithOwner();
    const raw = JSON.stringify(messageFor(store.phoneNumberId, phone));
    const response = await h.post(raw, await signBody("", raw));
    expect(response.status).toBe(500);
    expect(await inboundCount(store.businessId)).toBe(0);
    expect(await verifyWebhookSignature("", bytes(raw), await signBody("", raw))).toBe(false);
  });

  it("verifies directly: exact bytes only", async () => {
    const raw = '{"a":1}';
    const header = await signBody("k", raw);
    expect(await verifyWebhookSignature("k", bytes(raw), header)).toBe(true);
    expect(await verifyWebhookSignature("k", bytes(raw), header.toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
    expect(await verifyWebhookSignature("k", bytes('{"a":2}'), header)).toBe(false);
    expect(await verifyWebhookSignature("k", bytes(raw), undefined)).toBe(false);
  });
});

describe("GET verification", () => {
  const path = (token: string, mode = "subscribe") =>
    `/webhooks/whatsapp?hub.mode=${mode}&hub.challenge=1158201444&hub.verify_token=${encodeURIComponent(token)}`;

  it("echoes the challenge when the verify token matches", async () => {
    const response = await harness().get(path(TEST_VERIFY_TOKEN));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1158201444");
  });

  it("refuses a wrong token, a wrong mode, or a blank configured token", async () => {
    expect((await harness().get(path("wrong"))).status).toBe(403);
    expect((await harness().get(path(TEST_VERIFY_TOKEN, "unsubscribe"))).status).toBe(403);
    const blank = harness({ env: testEnv({ WHATSAPP_VERIFY_TOKEN: "" }) });
    expect((await blank.get(path(""))).status).toBe(403);
    expect(await verifyTokenMatches("", "")).toBe(false);
  });

  it("compares hashed tokens, so tokens of any length are just equal or not", async () => {
    expect(await verifyTokenMatches("abc", "abc")).toBe(true);
    for (const other of ["", "ab", "abd", "abcd", "abc ", "x".repeat(10_000)]) {
      expect(await verifyTokenMatches("abc", other)).toBe(false);
    }
    expect(await verifyTokenMatches("abc", undefined)).toBe(false);
  });
});
