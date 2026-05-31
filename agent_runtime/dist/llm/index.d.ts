/**
 * LLM module barrel export and factory.
 */
export type { LLMAdapter, LLMModelInfo, LLMUsage, LLMCallTrace, LLMGenerateInput, LLMGenerateOutput, } from "./llm_adapter";
export { MockLLMAdapter } from "./mock_adapter";
export type { MockMode } from "./mock_adapter";
export { OpenAICompatAdapter } from "./adapters/openai_compat";
export type { OpenAICompatOptions } from "./adapters/openai_compat";
import { LLMAdapter } from "./llm_adapter";
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
export declare function createLLMAdapterFromEnv(): LLMAdapter;
//# sourceMappingURL=index.d.ts.map