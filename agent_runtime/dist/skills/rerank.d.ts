/**
 * Rerank skill — extracts CZ/EZ ranked results from the upstream
 * fetch_recommendation node.
 *
 * Primary path: reads cz_ranked/ez_ranked from GRAPH INPUT (resolved
 * by the orchestrator from inputFrom mappings).
 *
 * Fallback path: if graph input fields are missing, reads from the
 * fetch_recommendation node's decision_trace via context. When
 * fallback is used, trace metadata records it for observability.
 */
import { Skill, RerankInput } from "../core/types";
export declare const rerankSkill: Skill<RerankInput, unknown>;
//# sourceMappingURL=rerank.d.ts.map