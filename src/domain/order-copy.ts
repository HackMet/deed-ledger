/**
 * The order handler's own replies, for moments no engine outcome names. Every other reply comes
 * from the replies templates (./replies.ts). Honduran Spanish, never blaming the customer.
 */

/** "Corregir": the order stays as it is until the customer says what to change. */
export const WHAT_TO_CORRECT = "Va. Decime qué le cambiamos al pedido.";

/** A typed answer that crossed a newer readback: nothing is confirmed until they answer that one. */
export const ANSWER_NEW_READBACK = "Tu pedido cambió. Revisá cómo quedó arriba y respondé Confirmar, Corregir o Cancelar.";
