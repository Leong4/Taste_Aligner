"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Orchestrator = void 0;
const execution_context_1 = require("./execution_context");
const trace_manager_1 = require("./trace_manager");
const graph_definition_1 = require("./graph_definition");
class Orchestrator {
    constructor(registry, graph) {
        this.registry = registry;
        this.graph = graph;
        // Validate graph at construction time — fail fast if misconfigured
        const graphErrors = (0, graph_definition_1.validateGraph)(this.graph);
        if (graphErrors.length > 0) {
            throw new Error(`[Orchestrator] Invalid graph "${this.graph.name}":\n` +
                graphErrors.map((e) => `  - ${e}`).join("\n"));
        }
        // Validate that all skills referenced by the graph are registered
        for (const node of this.graph.nodes) {
            if (!this.registry.has(node.skill)) {
                throw new Error(`[Orchestrator] Graph node "${node.id}" references ` +
                    `skill "${node.skill}" which is not registered. ` +
                    `Registered: [${this.registry.list().join(", ")}]`);
            }
        }
    }
    /**
     * Execute the full pipeline for a user request.
     */
    async run(input) {
        const ctx = (0, execution_context_1.createExecutionContext)(input);
        const pipelineStart = Date.now();
        let lastExecutedNodeId = null;
        console.log(`[Orchestrator] Starting pipeline "${this.graph.name}" v${this.graph.version} ` +
            `with ${this.graph.nodes.length} nodes`);
        for (const node of this.graph.nodes) {
            const nodeStart = Date.now();
            console.log(`[Orchestrator] Executing node: ${node.id} (skill: ${node.skill})`);
            try {
                // 1. Resolve input from context
                const resolvedInput = (0, execution_context_1.resolveNodeInput)(ctx, node.inputFrom);
                // 2. Execute skill
                const skill = this.registry.get(node.skill);
                const result = await skill.execute(resolvedInput, ctx);
                // 3. Store output
                (0, execution_context_1.storeResult)(ctx, node.id, result.output);
                lastExecutedNodeId = node.id;
                // 4. Merge decision trace
                if (result.trace && Object.keys(result.trace).length > 0) {
                    (0, trace_manager_1.mergeTrace)(ctx, node.skill, result.trace);
                }
                // 5. Record timing
                const durationMs = Date.now() - nodeStart;
                (0, execution_context_1.recordTiming)(ctx, node.id, durationMs);
                console.log(`[Orchestrator] Node "${node.id}" completed in ${durationMs}ms`);
                // 6. Check terminal signal from skill
                if (result.terminal) {
                    console.log(`[Orchestrator] Skill "${node.skill}" signaled terminal` +
                        (result.terminalReason ? `: ${result.terminalReason}` : ""));
                    (0, execution_context_1.recordTiming)(ctx, "_total", Date.now() - pipelineStart);
                    return this.buildOutput(ctx, lastExecutedNodeId, false, result.terminalReason);
                }
            }
            catch (err) {
                const durationMs = Date.now() - nodeStart;
                (0, execution_context_1.recordTiming)(ctx, node.id, durationMs);
                const message = err instanceof Error ? err.message : String(err);
                console.error(`[Orchestrator] Node "${node.id}" FAILED: ${message}`);
                (0, execution_context_1.addError)(ctx, node.id, node.skill, "skill_execution_error", message);
                // Fail-fast: all nodes in the linear pipeline are critical
                (0, execution_context_1.recordTiming)(ctx, "_total", Date.now() - pipelineStart);
                return this.buildOutput(ctx, lastExecutedNodeId, false);
            }
        }
        // Pipeline complete — build final output from last node
        (0, execution_context_1.recordTiming)(ctx, "_total", Date.now() - pipelineStart);
        return this.buildOutput(ctx, lastExecutedNodeId, true);
    }
    /**
     * Build OrchestratorOutput from the execution context.
     *
     * This method is generic — it does NOT reference any specific
     * node IDs. It uses the graph's outputMapping (if present) or
     * falls back to extracting common fields from the last node's output.
     */
    buildOutput(ctx, lastNodeId, pipelineComplete, terminalReason) {
        const lastOutput = lastNodeId
            ? ctx.intermediate_results[lastNodeId]
            : undefined;
        // If the last node returned a decision_trace bundle from a
        // downstream service, deep-merge it into the context trace.
        if (lastOutput) {
            const downstreamTrace = lastOutput.decision_trace;
            if (downstreamTrace &&
                typeof downstreamTrace === "object" &&
                !Array.isArray(downstreamTrace)) {
                (0, trace_manager_1.mergeTraceBundle)(ctx, downstreamTrace);
            }
        }
        // Extract structured fields from intermediate results.
        // Walk all stored results to find city/type (from whichever node
        // produced them) and cards/mix_policy (from the final node).
        let city = null;
        let type = "unknown";
        for (const nodeOutput of Object.values(ctx.intermediate_results)) {
            const obj = nodeOutput;
            if (!obj)
                continue;
            if (typeof obj.city === "string" && city === null) {
                city = obj.city;
            }
            if (typeof obj.type === "string" && type === "unknown") {
                type = obj.type;
            }
        }
        const cards = lastOutput?.cards ?? null;
        const mix_policy = lastOutput?.mix_policy ?? null;
        // If pipeline didn't complete and there were errors, ok = false
        const ok = pipelineComplete && ctx.errors.length === 0;
        // If terminal reason, add it to errors for visibility
        if (terminalReason && !pipelineComplete) {
            (0, execution_context_1.addError)(ctx, lastNodeId ?? "unknown", "orchestrator", "pipeline_terminated", terminalReason);
        }
        return {
            ok,
            city,
            type,
            cards,
            mix_policy,
            decision_trace: ctx.decision_trace,
            errors: ctx.errors,
            timing: ctx.timing,
        };
    }
}
exports.Orchestrator = Orchestrator;
//# sourceMappingURL=orchestrator.js.map