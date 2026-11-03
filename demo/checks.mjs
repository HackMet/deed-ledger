// Pure checks the demo runner applies to what the console answered. No I/O, so tests import them.

/**
 * A staff tap the engine refused because of the order itself: its state (`aviso=estado`,
 * invalid_state) or its version (`aviso=cambio`, stale_version). Any other notice, `permiso` above
 * all, is a refusal for some other reason and proves nothing about the order.
 */
export function refusedForTheOrder(redirect) {
  const notice = typeof redirect === "string" ? new URLSearchParams(redirect.split("#")[0].split("?")[1] ?? "").get("aviso") : null;
  return notice === "estado" || notice === "cambio";
}

/** The quantity a readback line shows for a product, or null when the line isn't there. */
export function readbackQuantity(reply, productName) {
  if (typeof reply !== "string") return null;
  for (const line of reply.split("\n")) {
    const match = /^• (\S+) (.+)$/u.exec(line);
    if (match !== null && match[2] === productName) return match[1];
  }
  return null;
}
