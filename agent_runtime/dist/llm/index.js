"use strict";
/**
 * LLM module barrel export and factory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAICompatAdapter = exports.MockLLMAdapter = void 0;
exports.createLLMAdapterFromEnv = createLLMAdapterFromEnv;
var mock_adapter_1 = require("./mock_adapter");
Object.defineProperty(exports, "MockLLMAdapter", { enumerable: true, get: function () { return mock_adapter_1.MockLLMAdapter; } });
var openai_compat_1 = require("./adapters/openai_compat");
Object.defineProperty(exports, "OpenAICompatAdapter", { enumerable: true, get: function () { return openai_compat_1.OpenAICompatAdapter; } });
const mock_adapter_2 = require("./mock_adapter");
const openai_compat_2 = require("./adapters/openai_compat");
// ---------------------------------------------------------------------------
// FallbackMockLLMAdapter — stands in when the intended provider is unavailable
// (missing API key, unknown provider, etc.).  Returns valid mock data but marks
// every callTrace with fallback_used=true and fallback_reason so skills can
// propagate the context into decision_trace.
// ---------------------------------------------------------------------------
class FallbackMockLLMAdapter extends mock_adapter_2.MockLLMAdapter {
    constructor(fallbackReason) {
        super("short");
        this.fallbackReason = fallbackReason;
    }
    async generateStructuredJSON(input) {
        const result = await super.generateStructuredJSON(input);
        const overriddenTrace = {
            ...result.callTrace,
            latency_ms: 0, // deterministic — no real call was made
            fallback_used: true,
            fallback_reason: this.fallbackReason,
        };
        return { ...result, callTrace: overriddenTrace };
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
/**
 * Create an LLM adapter based on environment configuration.
 *
 * Providers:
 *   - "mock" (default) — deterministic MockLLMAdapter; no network
 *   - "openai_compat"  — OpenAI-compatible HTTP adapter
 *       Requires LLM_API_KEY; falls back to FallbackMockAdapter if absent.
 *       Optional: LLM_BASE_URL, LLM_MODEL, LLM_MAX_RETRIES
 *
 * Unknown providers fall back to FallbackMockAdapter("unknown_provider").
 *
 * The adapter is injected into skills at bootstrap time, so swapping
 * providers requires zero changes to skill or graph code.
 */
function createLLMAdapterFromEnv() {
    const provider = process.env.LLM_PROVIDER ?? "mock";
    switch (provider) {
        case "mock":
            return new mock_adapter_2.MockLLMAdapter(process.env.LLM_MOCK_MODE ?? undefined);
        case "openai_compat": {
            const apiKey = process.env.LLM_API_KEY;
            if (!apiKey) {
                console.warn("[LLM] LLM_PROVIDER=openai_compat but LLM_API_KEY is not set. " +
                    "Falling back to mock adapter.");
                return new FallbackMockLLMAdapter("missing_api_key");
            }
            const adapterOpts = { apiKey };
            const baseUrl = process.env.LLM_BASE_URL;
            const model = process.env.LLM_MODEL;
            const maxRetriesStr = process.env.LLM_MAX_RETRIES;
            if (baseUrl !== undefined)
                adapterOpts.baseUrl = baseUrl;
            if (model !== undefined)
                adapterOpts.model = model;
            if (maxRetriesStr !== undefined)
                adapterOpts.maxRetries = parseInt(maxRetriesStr, 10);
            return new openai_compat_2.OpenAICompatAdapter(adapterOpts);
        }
        default:
            console.warn(`[LLM] Unknown LLM_PROVIDER="${provider}", falling back to mock adapter`);
            return new FallbackMockLLMAdapter("unknown_provider");
    }
}
//# sourceMappingURL=index.js.map