/**
 * Orchestrator — the central execution engine for the Taste Aligner pipeline.
 *
 * The orchestrator is GENERIC — it does not reference any specific
 * node IDs, skill names, or output shapes. All domain knowledge lives
 * in the skills and the graph definition.
 *
 * Termination contract:
 *   - A skill may return { terminal: true } to stop the pipeline early.
 *   - The orchestrator treats the last executed node's output as the
 *     final result regardless of how many nodes remain.
 *   - The graph's outputMapping (if present) controls how the final
 *     node's output is projected into OrchestratorOutput.
 */
import { SkillRegistry } from "./skill_registry";
import { GraphDefinition, OrchestratorInput, OrchestratorOutput } from "./types";
export declare class Orchestrator {
    private registry;
    private graph;
    constructor(registry: SkillRegistry, graph: GraphDefinition);
    /**
     * Execute the full pipeline for a user request.
     */
    run(input: OrchestratorInput): Promise<OrchestratorOutput>;
    /**
     * Build OrchestratorOutput from the execution context.
     *
     * This method is generic — it does NOT reference any specific
     * node IDs. It uses the graph's outputMapping (if present) or
     * falls back to extracting common fields from the last node's output.
     */
    private buildOutput;
}
//# sourceMappingURL=orchestrator.d.ts.map