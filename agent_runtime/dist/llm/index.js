"use strict";
/**
 * LLM module barrel export and factory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MockLLMAdapter = void 0;
exports.createLLMAdapterFromEnv = createLLMAdapterFromEnv;
var mock_adapter_1 = require("./mock_adapter");
Object.defineProperty(exports, "MockLLMAdapter", { enumerable: true, get: function () { return mock_adapter_1.MockLLMAdapter; } });
const mock_adapter_2 = require("./mock_adapter");
/**
 * Create an LLM adapter based on environment configuration.
 *
 * Current providers:
 *   - "mock" (default) — deterministic MockLLMAdapter
 *
 * Future providers (not yet implemented):
 *   - "openai"    — OpenAI API adapter
 *   - "anthropic" — Anthropic API adapter
 *
 * The adapter is injected into skills at bootstrap time, so swapping
 * providers requires zero changes to skill or graph code.
 */
function createLLMAdapterFromEnv() {
    const provider = process.env.LLM_PROVIDER ?? "mock";
    switch (provider) {
        case "mock":
            return new mock_adapter_2.MockLLMAdapter(process.env.LLM_MOCK_MODE ?? undefined);
        default:
            console.warn(`[LLM] Unknown LLM_PROVIDER="${provider}", falling back to mock adapter`);
            return new mock_adapter_2.MockLLMAdapter();
    }
}
//# sourceMappingURL=index.js.map