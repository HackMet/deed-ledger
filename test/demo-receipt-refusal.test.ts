/** Behind the demo walls, the receipt service itself refuses a demo store's upload; only the scripted demo history may add one. */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemberContext } from "../src/application/engine";
import { ReceiptService } from "../src/application/receipts";
import { D1CommitRunner } from "../src/infrastructure/d1/commit-runner";
import { D1ConsoleReceipts } from "../src/infrastructure/d1/console-receipts";
import { D1BusinessContext } from "../src/infrastructure/d1/business-context";
import { D1FactLedger, D1FactPrecheck } from "../src/infrastructure/d1/fact-ledger";
import { R2MediaStore } from "../src/infrastructure/r2-media-store";
import { RecordedReceiptReader } from "../src/integrations/perception/recorded-receipt-reader";
import { fixtureImage, receiptFixtures, receiptRecordings } from "./fixtures/receipts";

function service() {
  const db = env.DB;
  return new ReceiptService({
    store: new D1ConsoleReceipts(db, env.MEDIA),
    media: new R2MediaStore(env.MEDIA),
    reader: new RecordedReceiptReader(receiptRecordings),
    context: new D1BusinessContext(db),
    ledger: new D1FactLedger(db),
    precheck: new D1FactPrecheck(db),
    runner: new D1CommitRunner(db),
    ids: { newId: () => crypto.randomUUID() },
  });
}

const demoOwner = (): MemberContext => ({
  businessId: `demo-${crypto.randomUUID()}`,
  memberId: crypto.randomUUID(),
  role: "owner",
  canApproveFiado: false,
  nowMs: Date.now(),
});

describe("a demo store can't upload an invoice, whatever path reached the service", () => {
  it("refuses before anything is stored", async () => {
    const before = (await env.MEDIA.list()).objects.length;
    const bytes = fixtureImage(receiptFixtures.distribuidora);
    const result = await service().upload(demoOwner(), { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
    expect(result).toEqual({ type: "refused", reason: "not_allowed" });
    expect((await env.MEDIA.list()).objects.length).toBe(before);
  });
});
