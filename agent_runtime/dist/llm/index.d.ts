/**
 * LLM module barrel export and factory.
 */
export type { LLMAdapter, LLMModelInfo, LLMUsage, LLMCallTrace, LLMGenerateInput, LLMGenerateOutput, } from "./llm_adapter";
export { MockLLMAdapter } from "./mock_adapter";
export type { MockMode } from "./mock_adapter";
import { LLMAdapter } from "./llm_adapter";
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
export declare function createLLMAdapterFromEnv(): LLMAdapter;
//# sourceMappingURL=index.d.ts.map