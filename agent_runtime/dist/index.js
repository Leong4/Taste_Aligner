"use strict";
/**
 * CLI entry point for the Taste Aligner agent runtime.
 *
 * Uses the SkillRegistry + Graph + Orchestrator architecture.
 * Runs a single hardcoded query for development/debugging.
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const bootstrap_1 = require("./core/bootstrap");
async function main() {
    console.log("[agent_runtime] boot ok");
    const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8080";
    const timeoutMs = process.env.GATEWAY_TIMEOUT_MS
        ? Number(process.env.GATEWAY_TIMEOUT_MS)
        : 3000;
    const orchestrator = (0, bootstrap_1.createOrchestrator)({
        gatewayBaseUrl,
        timeoutMs,
        logPayload: true,
    });
    const result = await orchestrator.run({
        text: "I want to travel to London for food.",
    });
    console.log("\n[result]", JSON.stringify(result, null, 2));
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map