/**
 * memory_weight_adjust skill
 *
 * Calls memory.search via gateway, then deterministically sorts/aggregates
 * results into weighted_results, anchor_memory_ids, anchor_tags, and
 * memory_confidence.
 *
 * Determinism strategy:
 *   - input tags: deduped + sorted lexicographically
 *   - results sorted by (score desc, memory_id asc)
 *   - anchor_tags sorted by (-count desc, tag lex asc)
 *   - no Date.now() used in decisions (only for latency measurement)
 */
import { Skill, MemoryWeightAdjustInput, MemoryWeightAdjustOutput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createMemoryWeightAdjustSkill(toolClient: ToolClient): Skill<MemoryWeightAdjustInput, MemoryWeightAdjustOutput>;
//# sourceMappingURL=memory_weight_adjust.d.ts.map