/**
 * The verdicts each order's entry must carry, as a tally per state (null: a fact with no pair), measured on clean
 * runs. The rows are sorted by the time of each reply and fact, and the demo's clock moves between runs, so which
 * row holds which verdict moves too; how many rows hold each verdict does not. The recheck compares an entry with
 * the same judge's recomputation, so a judge broken in both places still agrees; these tallies are what catch it.
 */
export const EXPECTED_VERDICTS = {
  A: "emparejado 4, en_duda 2, null 2",
  D: "emparejado 2, null 4",
  E: "bloqueado 1, null 4",
};

/** Counts the rows per verdict, null as "null", keys sorted, e.g. "emparejado 2, null 4". */
export function tally(states) {
  const counts = {};
  for (const state of states) counts[state ?? "null"] = (counts[state ?? "null"] ?? 0) + 1;
  return Object.keys(counts).sort().map((state) => `${state} ${counts[state]}`).join(", ");
}

/** Throws, which fails the demo, unless this order's verdicts are the ones measured above. */
export function checkVerdicts(who, states) {
  const stored = tally(states);
  if (stored !== EXPECTED_VERDICTS[who]) {
    throw new Error(`the verdicts of ${who}'s entry are ${stored}, expected ${EXPECTED_VERDICTS[who]}`);
  }
}
