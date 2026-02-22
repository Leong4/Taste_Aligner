/**
 * tes_builder skill
 *
 * Calls embedding service TES endpoint through gateway tool routing and
 * returns a validated 512-dim TES vector with deterministic guards.
 */
import { Skill, TesBuilderInput, TesBuilderOutput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createTesBuilderSkill(toolClient: ToolClient): Skill<TesBuilderInput, TesBuilderOutput>;
//# sourceMappingURL=tes_builder.d.ts.map