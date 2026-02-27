"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrchestrator = createOrchestrator;
const skill_registry_1 = require("./skill_registry");
const orchestrator_1 = require("./orchestrator");
const graph_definition_1 = require("./graph_definition");
const toolClient_1 = require("../tools/toolClient");
const skills_1 = require("../skills");
const llm_1 = require("../llm");
/**
 * Create a fully wired Orchestrator ready for production use.
 */
function createOrchestrator(config = {}) {
    const gatewayBaseUrl = config.gatewayBaseUrl ?? "http://localhost:8080";
    const timeoutMs = config.timeoutMs ?? 3000;
    const logPayload = config.logPayload ?? true;
    // 1. Create gateway client
    const toolClient = new toolClient_1.ToolClient({
        gatewayBaseUrl,
        timeoutMs,
        logPayload,
    });
    // 2. Create and populate registry
    const registry = new skill_registry_1.SkillRegistry();
    // 2a. Create LLM adapter
    const llmAdapter = (0, llm_1.createLLMAdapterFromEnv)();
    console.log(`[bootstrap] LLM adapter: ${llmAdapter.modelInfo.provider}/${llmAdapter.modelInfo.model_name}`);
    // Register deterministic skills
    registry.register(skills_1.extractIntentSkill);
    registry.register(skills_1.decideTagBudgetSkill);
    registry.register((0, skills_1.createTagExpandSkill)(llmAdapter));
    registry.register((0, skills_1.createTagNormalizeSkill)());
    registry.register((0, skills_1.createMemorySignalSkill)(toolClient));
    registry.register((0, skills_1.createMemoryWeightAdjustSkill)(toolClient));
    registry.register((0, skills_1.createVisionDescribeSkill)(toolClient));
    registry.register((0, skills_1.createTesBuilderSkill)(toolClient));
    registry.register((0, skills_1.createFetchRecommendationSkill)(toolClient));
    registry.register((0, skills_1.createRerankSkill)(toolClient));
    registry.register(skills_1.mixPolicySkill);
    registry.register((0, skills_1.createBuildCardsSkill)(toolClient));
    // Register LLM-backed skills
    registry.register((0, skills_1.createExplainFromTraceSkill)(llmAdapter));
    console.log(`[bootstrap] Registered ${registry.size} skills: [${registry.list().join(", ")}]`);
    // 3. Create orchestrator with the default graph
    const orchestrator = new orchestrator_1.Orchestrator(registry, graph_definition_1.RECOMMENDATION_GRAPH);
    console.log(`[bootstrap] Orchestrator ready with graph "${graph_definition_1.RECOMMENDATION_GRAPH.name}" ` +
        `v${graph_definition_1.RECOMMENDATION_GRAPH.version}`);
    return orchestrator;
}
//# sourceMappingURL=bootstrap.js.map