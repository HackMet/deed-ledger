import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newPhone, seedStore } from "./helpers/seed";

const STATES = ["por_confirmar", "confirmado", "preparando", "armando", "listo", "entregado", "cancelado"];

const newStore = () => seedStore({ members: [{ phone: newPhone(), role: "owner" }] });

const insertOperation = (businessId: string, key: string) =>
  env.DB.prepare(`INSERT INTO operations (business_id, operation_key, outcome_json, created_at_ms) VALUES (?1, ?2, '{}', 0)`)
    .bind(businessId, key)
    .run();

const insertOrder = (businessId: string, id: string, state = "por_confirmar", currentVersion: number = 1) =>
  env.DB.prepare(`INSERT INTO orders (id, business_id, customer_id, state, current_version, created_at_ms) VALUES (?1, ?2, 'customer-1', ?3, ?4, 0)`)
    .bind(id, businessId, state, currentVersion)
    .run();

type VersionInput = {
  orderId?: string;
  version?: number;
  state?: string;
  total?: number | null;
  mode?: string | null;
  placeId?: string | null;
  placeText?: string | null;
  fee?: number | null;
};

const insertVersion = (businessId: string, v: VersionInput = {}) =>
  env.DB.prepare(
    `INSERT INTO order_versions (business_id, order_id, version, state, total_centavos, fulfillment_mode, place_id, place_text, delivery_fee_centavos, created_at_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)`,
  )
    .bind(
      businessId,
      v.orderId ?? "order-1",
      v.version ?? 1,
      v.state ?? "por_confirmar",
      v.total ?? null,
      v.mode ?? null,
      v.placeId ?? null,
      v.placeText ?? null,
      v.fee ?? null,
    )
    .run();

type LineInput = {
  orderId?: string;
  version?: number;
  lineNo?: number;
  productId?: string | null;
  text?: string;
  qty?: number | string | null;
  price?: number | null;
};

const insertLine = (businessId: string, l: LineInput = {}) =>
  env.DB.prepare(
    `INSERT INTO order_lines (business_id, order_id, version, line_no, product_id, customer_text, qty_milli, unit_price_centavos, excluded_from_total)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0)`,
  )
    .bind(
      businessId,
      l.orderId ?? "order-1",
      l.version ?? 1,
      l.lineNo ?? 1,
      l.productId === undefined ? "product-1" : l.productId,
      l.text ?? "dos libras de arroz",
      l.qty === undefined ? 1000 : l.qty,
      l.price === undefined ? 5000 : l.price,
    )
    .run();

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;

describe("orders schema: idempotency anchor", () => {
  it("rejects a second operation with the same key in the same store", async () => {
    const store = await newStore();
    await insertOperation(store.businessId, "op-duplicate");
    await expect(insertOperation(store.businessId, "op-duplicate")).rejects.toThrow(UNIQUE);
  });

  it("lets another store reuse a key, and still rejects the repeat in the same store", async () => {
    const a = await newStore();
    const b = await newStore();
    await insertOperation(a.businessId, "op-shared");
    await insertOperation(b.businessId, "op-shared");
    await expect(insertOperation(b.businessId, "op-shared")).rejects.toThrow(UNIQUE);
  });
});

describe("orders schema: store scoping of every UNIQUE", () => {
  it("lets another store reuse an order version, and rejects the repeat in the same store", async () => {
    const a = await newStore();
    const b = await newStore();
    await insertVersion(a.businessId);
    await insertVersion(b.businessId);
    await expect(insertVersion(b.businessId)).rejects.toThrow(UNIQUE);
  });

  it("lets another store reuse an order line number, and rejects the repeat in the same store", async () => {
    const a = await newStore();
    const b = await newStore();
    await insertLine(a.businessId);
    await insertLine(b.businessId);
    await expect(insertLine(b.businessId)).rejects.toThrow(UNIQUE);
  });

  it("rejects a repeated order id", async () => {
    const store = await newStore();
    await insertOrder(store.businessId, "order-dup");
    await expect(insertOrder(store.businessId, "order-dup")).rejects.toThrow(UNIQUE);
  });
});

describe("orders schema: states", () => {
  it.each(STATES)("accepts the state %s on an order and on a version", async (state) => {
    const store = await newStore();
    await insertOrder(store.businessId, `order-${state}`, state);
    await insertVersion(store.businessId, { orderId: `order-${state}`, state });
  });

  it("rejects an unknown state on an order", async () => {
    const store = await newStore();
    await expect(insertOrder(store.businessId, "order-1", "bogus")).rejects.toThrow(CHECK);
    await expect(insertOrder(store.businessId, "order-2", "lista")).rejects.toThrow(CHECK);
  });

  it("rejects an unknown state on a version", async () => {
    const store = await newStore();
    await expect(insertVersion(store.businessId, { state: "bogus" })).rejects.toThrow(CHECK);
    await expect(insertVersion(store.businessId, { state: "lista" })).rejects.toThrow(CHECK);
  });
});

describe("orders schema: unknown is NULL, never 0", () => {
  it("accepts a line with no product, no quantity and no price, keeping the customer's words", async () => {
    const store = await newStore();
    await insertLine(store.businessId, { productId: null, qty: null, price: null, text: "lo de siempre" });
    const row = await env.DB.prepare(`SELECT product_id, qty_milli, unit_price_centavos, customer_text FROM order_lines WHERE business_id = ?1`)
      .bind(store.businessId)
      .first();
    expect(row).toEqual({ product_id: null, qty_milli: null, unit_price_centavos: null, customer_text: "lo de siempre" });
  });

  it("accepts a NULL quantity", async () => {
    const store = await newStore();
    await insertLine(store.businessId, { qty: null });
  });

  it("accepts a NULL product_id", async () => {
    const store = await newStore();
    await insertLine(store.businessId, { productId: null });
  });

  it("accepts a NULL unit price", async () => {
    const store = await newStore();
    await insertLine(store.businessId, { price: null });
  });

  it("rejects a zero quantity", async () => {
    const store = await newStore();
    await expect(insertLine(store.businessId, { qty: 0 })).rejects.toThrow(CHECK);
  });

  it("rejects a negative quantity", async () => {
    const store = await newStore();
    await expect(insertLine(store.businessId, { qty: -1 })).rejects.toThrow(CHECK);
  });

  it("rejects a line without the customer's words", async () => {
    const store = await newStore();
    await expect(
      env.DB.prepare(
        `INSERT INTO order_lines (business_id, order_id, version, line_no, excluded_from_total) VALUES (?1, 'order-1', 1, 1, 0)`,
      )
        .bind(store.businessId)
        .run(),
    ).rejects.toThrow(/NOT NULL constraint failed/);
  });

  it("accepts a free line with unit price 0 and rejects a negative unit price", async () => {
    const store = await newStore();
    await insertLine(store.businessId, { price: 0 });
    await expect(insertLine(store.businessId, { lineNo: 2, price: -1 })).rejects.toThrow(CHECK);
  });

  it("rejects a negative order total and accepts an unknown one", async () => {
    const store = await newStore();
    await insertVersion(store.businessId, { total: null });
    await expect(insertVersion(store.businessId, { version: 2, total: -1 })).rejects.toThrow(CHECK);
  });
});

describe("orders schema: fulfillment", () => {
  it("accepts a version with no fulfillment yet", async () => {
    const store = await newStore();
    await insertVersion(store.businessId);
  });

  it("accepts a pickup order with no fee", async () => {
    const store = await newStore();
    await insertVersion(store.businessId, { mode: "pickup" });
  });

  it("accepts a delivery with an unknown place and fee, and with a known place and fee", async () => {
    const store = await newStore();
    await insertVersion(store.businessId, { mode: "delivery" });
    await insertVersion(store.businessId, { version: 2, mode: "delivery", placeId: "place-1", placeText: "frente al parque", fee: 0 });
  });

  it("rejects an unknown fulfillment mode", async () => {
    const store = await newStore();
    await expect(insertVersion(store.businessId, { mode: "teleport" })).rejects.toThrow(CHECK);
  });

  it("rejects a negative delivery fee", async () => {
    const store = await newStore();
    await expect(insertVersion(store.businessId, { mode: "delivery", fee: -1 })).rejects.toThrow(CHECK);
  });

  it("rejects a place or a fee on an order that is not a delivery", async () => {
    const store = await newStore();
    await expect(insertVersion(store.businessId, { mode: "pickup", fee: 0 })).rejects.toThrow(CHECK);
    await expect(insertVersion(store.businessId, { version: 2, mode: "pickup", placeText: "x" })).rejects.toThrow(CHECK);
    await expect(insertVersion(store.businessId, { version: 3, mode: null, placeId: "place-1" })).rejects.toThrow(CHECK);
  });
});

describe("orders schema: versions and line numbers start at 1", () => {
  it("rejects version 0 on an order header", async () => {
    const store = await newStore();
    await expect(insertOrder(store.businessId, "order-1", "por_confirmar", 0)).rejects.toThrow(CHECK);
  });

  it("rejects version 0 on an order version", async () => {
    const store = await newStore();
    await expect(insertVersion(store.businessId, { version: 0 })).rejects.toThrow(CHECK);
  });

  it("rejects version 0 on an order line", async () => {
    const store = await newStore();
    await expect(insertLine(store.businessId, { version: 0 })).rejects.toThrow(CHECK);
  });

  it("rejects line number 0", async () => {
    const store = await newStore();
    await expect(insertLine(store.businessId, { lineNo: 0 })).rejects.toThrow(CHECK);
  });
});

describe("orders schema: STRICT typing", () => {
  it("rejects text in an integer column of order_lines", async () => {
    const store = await newStore();
    await expect(insertLine(store.businessId, { qty: "two" })).rejects.toThrow(/datatype mismatch|cannot store|CHECK/i);
  });

  it("rejects a fractional value in an integer money column of order_lines", async () => {
    const store = await newStore();
    await expect(insertLine(store.businessId, { price: 1.5 })).rejects.toThrow(/datatype mismatch|cannot store/i);
  });
});
