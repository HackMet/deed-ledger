/**
 * Perception boundary, owned by the teammate. The engine will call `perceive()` with a request it
 * builds and get back an Observation v1, which stays untrusted until validated. Both shapes are
 * still being settled (architecture plan §9), so they are opaque here on purpose.
 */
export type PerceiveRequest = { readonly __contract: "perceive-request/pending" };
export type Observation = { readonly __contract: "obs/pending" };

export interface Perceiver {
  perceive(request: PerceiveRequest): Promise<Observation>;
}
