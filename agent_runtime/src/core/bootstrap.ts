/**
 * Bootstrap — factory module that wires up the SkillRegistry,
 * Graph, and Orchestrator for production use.
 *
 * This is the single entry point for creating a ready-to-run
 * Orchestrator instance. It:
 *   1. Creates a ToolClient for gateway communication
 *   2. Creates and populates the SkillRegistry with all skills
 *   3. Loads the default recommendation pipeline graph
 *   4. Creates and returns an Orchestrator
 *
 * Usage:
 *   const orchestrator = createOrchestrator({ gatewayBaseUrl, timeoutMs });
 *   const result = await orchestrator.run({ text: "..." });
 */

import { SkillRegistry } from "./skill_registry";
import { Orchestrator } from "./orchestrator";
import { RECOMMENDATION_GRAPH } from "./graph_definition";
import { ToolClient } from "../tools/toolClient";
import {
    extractIntentSkill,
    decideTagBudgetSkill,
    createTagExpandSkill,
    createTagNormalizeSkill,
    createMemorySignalSkill,
    createMemoryWeightAdjustSkill,
    createBuildProfileVectorSkill,
    createVisionDescribeSkill,
    captionSentimentSkill,
    createTesBuilderSkill,
    createPersistMemorySkill,
    createFetchRecommendationSkill,
    createRerankSkill,
    mixPolicySkill,
    createBuildCardsSkill,
    createExplainFromTraceSkill,
} from "../skills";
import { createLLMAdapterFromEnv } from "../llm";

export interface OrchestratorConfig {
    /** Gateway base URL (default: http://localhost:8080) */
    gatewayBaseUrl?: string;
    /** Gateway timeout in ms (default: 3000) */
    timeoutMs?: number;
    /** Log gateway payloads for debugging (default: true) */
    logPayload?: boolean;
}

/**
 * Create a fully wired Orchestrator ready for production use.
 */
export function createOrchestrator(config: OrchestratorConfig = {}): Orchestrator {
    const gatewayBaseUrl = config.gatewayBaseUrl ?? "http://localhost:8080";
    const timeoutMs = config.timeoutMs ?? 3000;
    const logPayload = config.logPayload ?? true;

    // 1. Create gateway client
    const toolClient = new ToolClient({
        gatewayBaseUrl,
        timeoutMs,
        logPayload,
    });

    // 2. Create and populate registry
    const registry = new SkillRegistry();

    // 2a. Create LLM adapter
    const llmAdapter = createLLMAdapterFromEnv();
    console.log(`[bootstrap] LLM adapter: ${llmAdapter.modelInfo.provider}/${llmAdapter.modelInfo.model_name}`);

    // Register deterministic skills
    registry.register(extractIntentSkill);
    registry.register(decideTagBudgetSkill);
    registry.register(createTagExpandSkill(llmAdapter));
    registry.register(createTagNormalizeSkill(toolClient));
    // Registered only for callers/tests that still address the legacy skill by
    // name. RECOMMENDATION_GRAPH v13 does not contain a memory_signal node.
    registry.register(createMemorySignalSkill(toolClient));
    registry.register(createMemoryWeightAdjustSkill(toolClient));
    registry.register(createBuildProfileVectorSkill());  // no tool client needed — pure computation
    registry.register(createVisionDescribeSkill(toolClient));
    registry.register(captionSentimentSkill);
    registry.register(createTesBuilderSkill(toolClient));
    registry.register(createPersistMemorySkill());
    registry.register(createFetchRecommendationSkill(toolClient));
    registry.register(createRerankSkill(toolClient));
    registry.register(mixPolicySkill);
    registry.register(createBuildCardsSkill(toolClient));

    // Register LLM-backed skills
    registry.register(createExplainFromTraceSkill(llmAdapter));

    console.log(
        `[bootstrap] Registered ${registry.size} skills: [${registry.list().join(", ")}]`
    );

    // 3. Create orchestrator with the default graph
    const orchestrator = new Orchestrator(registry, RECOMMENDATION_GRAPH);

    console.log(
        `[bootstrap] Orchestrator ready with graph "${RECOMMENDATION_GRAPH.name}" ` +
        `v${RECOMMENDATION_GRAPH.version}`
    );

    return orchestrator;
}
