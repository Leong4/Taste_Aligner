/**
 * MixPolicy skill — extracts the CZ:EZ ratio decision.
 *
 * Primary path: reads mix_policy and decision_trace from GRAPH INPUT
 * (resolved from the fetch_recommendation node's output).
 *
 * Fallback path: if graph input is missing, scans context for any
 * node that produced mix_policy data.
 *
 * Also assembles the upstream_trace bundle for the build_cards node.
 */
import { Skill, MixPolicyInput } from "../core/types";
export declare const mixPolicySkill: Skill<MixPolicyInput, unknown>;
//# sourceMappingURL=mix_policy.d.ts.map