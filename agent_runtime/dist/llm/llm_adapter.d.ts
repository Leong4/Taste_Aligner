/**
 * LLMAdapter — abstract interface for structured LLM generation.
 *
 * All LLM-backed skills call through this interface so that:
 *   - Mock adapter can be used for testing/development
 *   - Real API adapter (OpenAI, Anthropic, etc.) can be plugged in
 *     later without rewiring any skill or graph code
 *
 * The adapter returns structured JSON (not free-text) and includes
 * a trace fragment for decision_trace auditing.
 */
/** Identifies the model used for a call (recorded in decision_trace). */
export interface LLMModelInfo {
    provider: string;
    model_name: string;
    version: string;
}
/** Token usage statistics (optional — mock returns zeros). */
export interface LLMUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}
/** Trace fragment recorded per LLM call for decision_trace. */
export interface LLMCallTrace {
    model: LLMModelInfo;
    temperature: number;
    prompt_version: string;
    latency_ms: number;
    usage: LLMUsage;
    fallback_used: boolean;
    /** Set when the adapter itself fell back (e.g. missing key, unknown provider). */
    fallback_reason?: string;
}
/** Input to an LLM generation call. */
export interface LLMGenerateInput {
    /** System-level instruction for the model. */
    systemPrompt: string;
    /** User-level prompt (the actual request). */
    userPrompt: string;
    /**
     * Plain-object JSON schema describing the expected output shape.
     * Used by API adapters for structured output; mock uses it for
     * documentation only.
     */
    schema: Record<string, unknown>;
    /** Sampling temperature (0 = deterministic). */
    temperature: number;
    /** Version tag for the prompt template (for trace). */
    promptVersion: string;
    /** Optional trace context passed to the adapter for logging. */
    traceContext?: Record<string, unknown>;
}
/** Output from an LLM generation call. */
export interface LLMGenerateOutput<T> {
    /** The parsed structured response. */
    data: T;
    /** Raw model response (for debugging; undefined in mock). */
    raw?: unknown;
    /** Token usage statistics. */
    usage: LLMUsage;
    /** Full call trace for decision_trace. */
    callTrace: LLMCallTrace;
}
/**
 * Abstract LLM adapter interface.
 *
 * Implementations:
 *   - MockLLMAdapter — deterministic, no network (default)
 *   - (future) OpenAIAdapter, AnthropicAdapter, etc.
 */
export interface LLMAdapter {
    /** Model info for this adapter instance. */
    readonly modelInfo: LLMModelInfo;
    /**
     * When set, this adapter is a fallback standing in for the intended
     * provider (e.g. missing API key). The value is the reason string
     * that gets propagated into decision_trace.llm_call.fallback_reason.
     */
    readonly fallbackReason?: string;
    /**
     * Generate a structured JSON response.
     *
     * @param input - prompt, schema, and configuration
     * @returns parsed data + trace metadata
     * @throws on unrecoverable errors (adapter should NOT throw on
     *         recoverable failures — return fallback data instead)
     */
    generateStructuredJSON<T>(input: LLMGenerateInput): Promise<LLMGenerateOutput<T>>;
}
//# sourceMappingURL=llm_adapter.d.ts.map