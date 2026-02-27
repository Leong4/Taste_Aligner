/**
 * LLM module barrel export and factory.
 */

export type {
    LLMAdapter,
    LLMModelInfo,
    LLMUsage,
    LLMCallTrace,
    LLMGenerateInput,
    LLMGenerateOutput,
} from "./llm_adapter";
export { MockLLMAdapter } from "./mock_adapter";
export type { MockMode } from "./mock_adapter";
export { OpenAICompatAdapter } from "./adapters/openai_compat";
export type { OpenAICompatOptions } from "./adapters/openai_compat";

import { LLMAdapter, LLMCallTrace, LLMGenerateInput, LLMGenerateOutput } from "./llm_adapter";
import { MockLLMAdapter } from "./mock_adapter";
import { OpenAICompatAdapter, OpenAICompatOptions } from "./adapters/openai_compat";

// ---------------------------------------------------------------------------
// FallbackMockLLMAdapter — stands in when the intended provider is unavailable
// (missing API key, unknown provider, etc.).  Returns valid mock data but marks
// every callTrace with fallback_used=true and fallback_reason so skills can
// propagate the context into decision_trace.
// ---------------------------------------------------------------------------

class FallbackMockLLMAdapter extends MockLLMAdapter {
    readonly fallbackReason: string;

    constructor(fallbackReason: string) {
        super("short");
        this.fallbackReason = fallbackReason;
    }

    async generateStructuredJSON<T>(
        input: LLMGenerateInput
    ): Promise<LLMGenerateOutput<T>> {
        const result = await super.generateStructuredJSON<T>(input);
        const overriddenTrace: LLMCallTrace = {
            ...result.callTrace,
            latency_ms: 0,       // deterministic — no real call was made
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
export function createLLMAdapterFromEnv(): LLMAdapter {
    const provider = process.env.LLM_PROVIDER ?? "mock";

    switch (provider) {
        case "mock":
            return new MockLLMAdapter(
                (process.env.LLM_MOCK_MODE as "short" | "long" | "error" | undefined) ?? undefined
            );

        case "openai_compat": {
            const apiKey = process.env.LLM_API_KEY;
            if (!apiKey) {
                console.warn(
                    "[LLM] LLM_PROVIDER=openai_compat but LLM_API_KEY is not set. " +
                    "Falling back to mock adapter."
                );
                return new FallbackMockLLMAdapter("missing_api_key");
            }
            const adapterOpts: OpenAICompatOptions = { apiKey };
            const baseUrl = process.env.LLM_BASE_URL;
            const model = process.env.LLM_MODEL;
            const maxRetriesStr = process.env.LLM_MAX_RETRIES;
            if (baseUrl !== undefined) adapterOpts.baseUrl = baseUrl;
            if (model !== undefined) adapterOpts.model = model;
            if (maxRetriesStr !== undefined) adapterOpts.maxRetries = parseInt(maxRetriesStr, 10);
            return new OpenAICompatAdapter(adapterOpts);
        }

        default:
            console.warn(
                `[LLM] Unknown LLM_PROVIDER="${provider}", falling back to mock adapter`
            );
            return new FallbackMockLLMAdapter("unknown_provider");
    }
}
