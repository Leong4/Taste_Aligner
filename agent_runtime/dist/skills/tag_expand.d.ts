/**
 * TagExpand skill — expands seed tags with LLM-generated hard/soft candidates,
 * then applies deterministic filtering, deduplication, thresholding, and limits.
 */
import { Skill, TagExpandInput, TagExpandOutput } from "../core/types";
import { LLMAdapter } from "../llm/llm_adapter";
export declare function createTagExpandSkill(adapter: LLMAdapter): Skill<TagExpandInput, TagExpandOutput>;
//# sourceMappingURL=tag_expand.d.ts.map