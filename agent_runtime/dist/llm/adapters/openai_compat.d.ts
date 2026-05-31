/**
 * OpenAICompatAdapter — production LLM adapter for OpenAI-compatible endpoints.
 *
 * Compatible with:
 *   - OpenAI API (https://api.openai.com/v1)
 *   - Qwen and other OpenAI-compatible endpoints
 *
 * Design decisions:
 *   - Uses Node's built-in http/https modules (no fetch, no extra deps)
 *   - latency_ms is set to 0 in callTrace for deterministic decision_trace
 *   - Retries up to LLM_MAX_RETRIES times (default: 2) on network/server errors
 *   - Throws on unrecoverable error so the skill's catch block handles fallback
 */
import { LLMAdapter, LLMGenerateInput, LLMGenerateOutput, LLMModelInfo } from "../llm_adapter";
export interface OpenAICompatOptions {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    maxRetries?: number;
}
export declare class OpenAICompatAdapter implements LLMAdapter {
    readonly modelInfo: LLMModelInfo;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly maxRetries;
    constructor(options: OpenAICompatOptions);
    generateStructuredJSON<T>(input: LLMGenerateInput): Promise<LLMGenerateOutput<T>>;
}
//# sourceMappingURL=openai_compat.d.ts.map