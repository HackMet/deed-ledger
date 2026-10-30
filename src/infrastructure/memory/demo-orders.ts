/** Synthetic orders for the dev console's pretend engine. Names and products are made up. */
import type { OrderLineView, OrderView } from "../../domain/contract/outcomes";
import type { StoredOrder } from "./memory-engine";

function line(lineId: string, over: Partial<OrderLineView>): OrderLineView {
  return {
    lineId,
    text: "",
    productId: null,
    productName: null,
    quantity: null,
    unit: null,
    unitPrice: null,
    availability: "hay",
    restricted: false,
    mark: null,
    substitute: null,
    ...over,
  };
}

function order(orderId: string, over: Partial<OrderView> & Pick<OrderView, "lines">): OrderView {
  return { orderId, version: 1, state: "confirmado", fulfillment: { mode: "pickup" }, total: null, queuePosition: null, ...over };
}

export function demoOrders(nowMs: number): StoredOrder[] {
  const minutesAgo = (m: number) => nowMs - m * 60_000;
  return [
    {
      customerId: "demo-customer-1",
      customerName: "Carla",
      confirmedAtMs: minutesAgo(25),
      changedLineIds: ["d1-3"],
      order: order("demo-order-1", {
        version: 2,
        state: "preparando",
        lines: [
          line("d1-1", { text: "1 aceite clover", productId: "p-aceite", productName: "Aceite Clover 1 L", quantity: "1", unitPrice: 6000 }),
          line("d1-2", { text: "3 lb arroz", productId: "p-arroz", productName: "Arroz 1 lb", quantity: "3", unitPrice: 3000, mark: "listo" }),
          line("d1-3", { text: "que sean 3 de azúcar", productId: "p-azucar", productName: "Azúcar 1 lb", quantity: "3", unitPrice: 3000 }),
          line("d1-4", { text: "3 jabon xtra", productId: "p-jabon", productName: "Jabón Xtra", quantity: "3", unitPrice: 3500 }),
        ],
        total: 34500,
        queuePosition: 1,
      }),
    },
    {
      customerId: "demo-customer-2",
      customerName: "Don Mario",
      confirmedAtMs: minutesAgo(12),
      changedLineIds: [],
      order: order("demo-order-2", {
        lines: [
          line("d2-1", { text: "2 coca de 2 litros", productId: "p-coca-2l", productName: "Coca-Cola 2 L", quantity: "2", unitPrice: 5500 }),
          line("d2-2", { text: "la manteca de la roja", quantity: "1", availability: "no_se" }),
        ],
        fulfillment: { mode: "delivery", placeId: null, placeText: "frente a la iglesia, casa verde", fee: null },
        queuePosition: 2,
      }),
    },
    {
      customerId: "demo-customer-3",
      customerName: null,
      confirmedAtMs: minutesAgo(4),
      changedLineIds: [],
      order: order("demo-order-3", {
        lines: [
          line("d3-1", { text: "media libra de frijoles", productId: "p-frijol", productName: "Frijoles 1 lb", quantity: "0.5", unitPrice: 2800 }),
          line("d3-2", { text: "1 cartón de huevos", productId: "p-huevos", productName: "Huevos (cartón)", quantity: "1", unitPrice: 9000 }),
        ],
        total: 10400,
        queuePosition: 3,
      }),
    },
  ];
}
