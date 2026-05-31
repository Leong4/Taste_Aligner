/**
 * TagNormalize skill — deterministic normalization from expanded tags to the
 * ontology standard tag space.
 *
 * Prefers the remote ontology.normalize gateway tool when a toolClient is
 * supplied.  Falls back to local dictionary matching on any error.
 */
import { Skill, TagNormalizeInput, TagNormalizeOutput } from "../core/types";
interface ToolClientLike {
    call(action: {
        tool: string;
        input: Record<string, unknown>;
    }): Promise<unknown>;
}
export declare function createTagNormalizeSkill(toolClient?: ToolClientLike): Skill<TagNormalizeInput, TagNormalizeOutput>;
export {};
//# sourceMappingURL=tag_normalize.d.ts.map