/**
 * Opens a demo store for one visitor of the public demo: a made-up mercadito with its own products,
 * prices, hours and delivery fee, and the visitor signed in as its owner. Products, prices and the
 * store's details go through the same services the owner's console uses, so the demo's ledger is
 * the product's. Nothing in it is real: names, numbers and prices are synthetic.
 */
import type { MemberContext } from "./engine";
import type { BusinessService } from "./business";
import type { CatalogService } from "./catalog";
import type { Clock, IdSource, Logger, Tenant } from "./ports";
import { describeError } from "./errors";
import type { Centavos } from "../domain/contract/numbers";
import type { StoreHours } from "../domain/contract/outcomes";
import {
  DEMO_BUSINESS_PREFIX,
  DEMO_STORE_TTL_MS,
  type DemoLimit,
  demoLimitReached,
  newDemoPhone,
  newDemoPhoneNumberId,
} from "../domain/demo";

/** Everything one demo store needs written in a single batch. */
export interface NewDemoStore {
  readonly businessId: string;
  readonly locationId: string;
  readonly channelAccountId: string;
  readonly phoneNumberId: string;
  readonly ownerUserId: string;
  readonly ownerPhone: string;
  readonly ownerName: string;
  readonly storeName: string;
  readonly customerPhone: string;
  readonly visitorHash: string;
  readonly sessionId: string;
  readonly sessionTokenHash: string;
  readonly nowMs: number;
  readonly expiresAtMs: number;
}

export interface DemoStoreWriter {
  /** How many demo stores this visitor, and everyone, opened in the hour before `nowMs`. */
  recentCounts(visitorHash: string, nowMs: number): Promise<{ readonly visitor: number; readonly everyone: number }>;
  create(store: NewDemoStore): Promise<void>;
}

export interface DemoSetupWriter {
  saveHours(tenant: Tenant, hours: StoreHours | null, nowMs: number): Promise<void>;
  saveDeliveryFee(tenant: Tenant, fee: Centavos | null, nowMs: number): Promise<void>;
}

export const DEMO_STORE_NAME = "Mercadito Demo";
const DEMO_OWNER_NAME = "Dueño (demo)";

/** Lempiras, as a small Honduran mercadito might price them. Made up. */
const PRODUCTS: readonly (readonly [string, number])[] = [
  ["Coca-Cola 600 ml", 25],
  ["Coca-Cola 2 L", 55],
  ["Pepsi 600 ml", 22],
  ["Agua Azul 1 L", 18],
  ["Arroz 1 lb", 18],
  ["Frijoles rojos 1 lb", 24],
  ["Azúcar 1 lb", 16],
  ["Maseca 1 kg", 38],
  ["Harina de trigo 1 lb", 15],
  ["Aceite Clover 1 L", 62],
  ["Manteca 1 lb", 30],
  ["Cartón de huevos (30)", 135],
  ["Huevo (unidad)", 5],
  ["Leche entera 1 L", 34],
  ["Mantequilla crema 1 lb", 45],
  ["Queso seco 1 lb", 70],
  ["Café molido 200 g", 48],
  ["Pan de molde", 42],
  ["Pan dulce (unidad)", 6],
  ["Tortillas (paquete de 10)", 20],
  ["Consomé de pollo (cubito)", 3],
  ["Sal 1 lb", 8],
  ["Salsa de tomate", 20],
  ["Espagueti 200 g", 14],
  ["Sardina en lata", 28],
  ["Jabón Xtra (barra)", 22],
  ["Detergente 500 g", 40],
  ["Papel higiénico (4 rollos)", 48],
  ["Pasta dental", 35],
  ["Baleadas congeladas (paquete)", 60],
  ["Tajadas de plátano", 15],
  ["Galletas de soda", 12],
  ["Chicle (unidad)", 2],
  ["Bolsa de hielo", 15],
  ["Gas para encendedor", 30],
];

/** Monday to Saturday 6:00–20:00, Sunday 7:00–12:00 (store-setup days are ISO: 1 is Monday). */
const SETUP_HOURS: StoreHours = [
  { days: [1, 2, 3, 4, 5, 6], opens: "06:00", closes: "20:00" },
  { days: [7], opens: "07:00", closes: "12:00" },
];
/** The same hours for Mi tienda, whose days are 0 (Sunday) to 6. */
const INFO_HOURS = [
  ...[1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: "06:00", closes: "20:00" })),
  { day: 0, opens: "07:00", closes: "12:00" },
];
const DELIVERY_FEE: Centavos = 2000;

export interface DemoStoreDeps {
  readonly stores: DemoStoreWriter;
  readonly catalog: CatalogService;
  readonly business: BusinessService;
  readonly setup: DemoSetupWriter;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly log: Logger;
  /** Random bytes for the synthetic numbers. */
  readonly random: (n: number) => Uint8Array;
  readonly hashToken: (token: string) => Promise<string>;
  readonly newToken: () => string;
}

export type OpenDemoResult =
  | { readonly type: "opened"; readonly businessId: string; readonly sessionToken: string; readonly expiresAtMs: number }
  | { readonly type: "limited"; readonly limit: Exclude<DemoLimit, null> };

export async function openDemoStore(deps: DemoStoreDeps, visitorHash: string): Promise<OpenDemoResult> {
  const nowMs = deps.clock.now();
  const counts = await deps.stores.recentCounts(visitorHash, nowMs);
  const limit = demoLimitReached(counts.visitor, counts.everyone);
  if (limit !== null) {
    deps.log.info("demo_store_limited", { reason: limit });
    return { type: "limited", limit };
  }

  const businessId = `${DEMO_BUSINESS_PREFIX}${deps.ids.newId()}`;
  const ownerUserId = deps.ids.newId();
  const sessionToken = deps.newToken();
  const expiresAtMs = nowMs + DEMO_STORE_TTL_MS;
  await deps.stores.create({
    businessId,
    locationId: deps.ids.newId(),
    channelAccountId: deps.ids.newId(),
    phoneNumberId: newDemoPhoneNumberId(deps.random),
    ownerUserId,
    ownerPhone: newDemoPhone(deps.random),
    ownerName: DEMO_OWNER_NAME,
    storeName: DEMO_STORE_NAME,
    customerPhone: newDemoPhone(deps.random),
    visitorHash,
    sessionId: deps.ids.newId(),
    sessionTokenHash: await deps.hashToken(sessionToken),
    nowMs,
    expiresAtMs,
  });
  deps.log.info("demo_store_opened", { businessId });

  const owner: MemberContext = { businessId, memberId: ownerUserId, role: "owner", canApproveFiado: true, nowMs };
  await seed(deps, owner);
  return { type: "opened", businessId, sessionToken, expiresAtMs };
}

/**
 * Products with prices, hours, the delivery fee and the store's details. A step that fails is
 * logged and skipped: the visitor still gets a store, with less in it, rather than an error.
 */
async function seed(deps: DemoStoreDeps, owner: MemberContext): Promise<void> {
  const steps: readonly (readonly [string, () => Promise<unknown>])[] = [
    ["prices", () => deps.catalog.importPrices(owner, PRODUCTS.map(([name, lempiras]) => ({ name, price: lempiras * 100 })))],
    ["hours", () => deps.setup.saveHours(owner, SETUP_HOURS, owner.nowMs)],
    ["delivery_fee", () => deps.setup.saveDeliveryFee(owner, DELIVERY_FEE, owner.nowMs)],
    [
      "business_info",
      () =>
        deps.business.recordBusinessInfo(owner, {
          name: DEMO_STORE_NAME,
          storeType: "mercadito",
          hours: INFO_HOURS,
          address: "Barrio El Centro, media cuadra del parque (dirección de ejemplo)",
          deliveryZones: "Barrio El Centro y colonias cercanas",
          assistantNotes: "Tienda de demostración: los productos, precios y clientes son de ejemplo.",
        }),
    ],
  ];
  for (const [step, run] of steps) {
    try {
      await run();
    } catch (error) {
      deps.log.warn("demo_seed_step_failed", { businessId: owner.businessId, reason: `${step}: ${describeError(error)}` });
    }
  }
}
