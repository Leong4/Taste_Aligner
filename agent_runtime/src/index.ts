import "dotenv/config";
import { ReActRuntime } from "./runtime/reactRuntime";
import { ToolClient } from "./tools/toolClient";
import { IntentAgent } from "./agents/intentAgent";

async function main() {
    console.log("[agent_runtime] boot ok");

    const agent = new IntentAgent();

    // Config: prefer env, fallback to local Gateway
    const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8080";
    const timeoutMs = process.env.GATEWAY_TIMEOUT_MS
        ? Number(process.env.GATEWAY_TIMEOUT_MS)
        : 3000;

    const toolClient = new ToolClient({
        gatewayBaseUrl,
        timeoutMs,
        logPayload: true,
    });

    const runtime = new ReActRuntime(agent, toolClient, { maxTurns: 3 });

    await runtime.run("I want to travel to London for food.");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
