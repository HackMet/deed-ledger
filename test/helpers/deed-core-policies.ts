/**
 * Two synthetic policies from two industries that the core has never heard of. Each is plain data: the core
 * itself is not edited to run either of them.
 */
import type { Policy } from "../../src/deed-core";

/** A clinic's lab: a sample is taken by a clinician; a result comes from a device; a result can be corrected. */
export const clinicPolicy: Policy = {
  kinds: {
    sample_taken: { evidence: [{ require: [{ kind: "clinician", min: 1, max: 1 }] }] },
    result_reported: { evidence: [{ require: [{ kind: "lab_device", min: 1 }] }] },
    result_corrected: {
      evidence: [
        { when: { kind: "lab_device", min: 2 }, require: [{ kind: "lab_device", min: 2 }, { kind: "clinician", min: 1 }] },
        { require: [{ kind: "clinician", min: 1, max: 1 }] },
      ],
    },
  },
};

/** A freight flow: a shipment is declared with a carrier scan; customs clearance needs exactly one officer. */
export const freightPolicy: Policy = {
  kinds: {
    shipment_declared: { evidence: [{ require: [{ kind: "carrier_scan", min: 1 }] }] },
    customs_cleared: { evidence: [{ require: [{ kind: "officer", min: 1, max: 1 }] }] },
  },
};

export const policies = { clinic: clinicPolicy, freight: freightPolicy } as const;

export type PolicyName = keyof typeof policies;
