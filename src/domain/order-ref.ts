import { sha256Hex } from "./sha256";

/** An order's reference, which staff can search in the console. 8 hex, from the order's id. Customers never see it. */
export const orderRef = (orderId: string): string => sha256Hex(`ref:${orderId}`).slice(0, 8);
