/**
 * memory_signal skill (A phase)
 *
 * Aggregates memory service search results into deterministic signal features:
 *   - anchor_tags
 *   - memory_confidence
 *
 * Determinism strategy:
 *   - input tags are normalized + deduped + sorted
 *   - results are sorted by (score desc, memory_id asc)
 *   - anchor tags are deduped + sorted
 *   - now_ts is fixed from input.now_ts or context.request_ts
 */
import { Skill, MemorySignalInput, MemorySignalOutput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createMemorySignalSkill(toolClient: ToolClient): Skill<MemorySignalInput, MemorySignalOutput>;
//# sourceMappingURL=memory_signal.d.ts.map