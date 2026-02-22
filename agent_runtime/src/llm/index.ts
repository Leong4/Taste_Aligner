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

import { LLMAdapter } from "./llm_adapter";
import { MockLLMAdapter, MockMode } from "./mock_adapter";

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
export function createLLMAdapterFromEnv(): LLMAdapter {
    const provider = process.env.LLM_PROVIDER ?? "mock";

    switch (provider) {
        case "mock":
            return new MockLLMAdapter(
                (process.env.LLM_MOCK_MODE as MockMode | undefined) ?? undefined
            );

        default:
            console.warn(
                `[LLM] Unknown LLM_PROVIDER="${provider}", falling back to mock adapter`
            );
            return new MockLLMAdapter();
    }
}
