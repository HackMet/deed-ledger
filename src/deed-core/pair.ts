/**
 * Pairing: a claim against the witnesses that could corroborate it. Silence is in doubt, never unpaired (C7).
 * The host maps the four states to its own words.
 */

export type PairState = "paired" | "unpaired" | "in_doubt" | "blocked";

/** What one witness says about a claim: it corroborates it, contradicts it, refuses it, or says nothing yet. */
export type Corroboration = "match" | "conflict" | "blocked" | "silent";

/**
 * Any match pairs the claim. Otherwise a refusal blocks it, a contradiction leaves it unpaired, and anything else,
 * including no witness at all, is in doubt.
 */
export function pair<C, W>(claim: C, witnesses: readonly W[], corroborates: (claim: C, witness: W) => Corroboration): PairState {
  const results = witnesses.map((witness) => corroborates(claim, witness));
  if (results.includes("match")) return "paired";
  if (results.includes("blocked")) return "blocked";
  if (results.includes("conflict")) return "unpaired";
  return "in_doubt";
}
