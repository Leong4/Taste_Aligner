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
import { Orchestrator } from "./orchestrator";
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
export declare function createOrchestrator(config?: OrchestratorConfig): Orchestrator;
//# sourceMappingURL=bootstrap.d.ts.map