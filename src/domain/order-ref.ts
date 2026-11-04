import { sha256Hex } from "./sha256";

/** C11: the reference a customer's message carries, which resolves to that order's entry. 8 hex, from the order's id. */
export const orderRef = (orderId: string): string => sha256Hex(`ref:${orderId}`).slice(0, 8);
