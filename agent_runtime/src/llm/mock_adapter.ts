/**
 * MockLLMAdapter — deterministic LLM adapter for development and testing.
 *
 * Returns canned structured responses without any network calls.
 * Supports configurable modes via LLM_MOCK_MODE env var:
 *   - "short"  (default) — concise explanation
 *   - "long"   — detailed explanation with more bullets
 *   - "error"  — simulates adapter failure (throws)
 *
 * All responses include valid LLMCallTrace metadata so that
 * decision_trace integration can be tested end-to-end.
 */

import {
    LLMAdapter,
    LLMModelInfo,
    LLMUsage,
    LLMGenerateInput,
    LLMGenerateOutput,
    LLMCallTrace,
} from "./llm_adapter";

export type MockMode = "short" | "long" | "error";

const MOCK_MODEL_INFO: LLMModelInfo = {
    provider: "mock",
    model_name: "mock-v1",
    version: "1.0.0",
};

const ZERO_USAGE: LLMUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
};

/** Mock responses keyed by mode. */
const MOCK_RESPONSES: Record<"short" | "long", { explanation: string; bullets: string[] }> = {
    short: {
        explanation:
            "Based on your preferences, we selected comfort-zone restaurants in your city " +
            "with a balanced exploration mix.",
        bullets: [
            "City matched from your input",
            "Comfort-zone items ranked by affinity score",
            "Exploration items added for variety",
        ],
    },
    long: {
        explanation:
            "We analyzed your request and identified your preferred city and cuisine type. " +
            "The recommendation engine scored candidates using your taste profile, applied " +
            "cross-city guards, and produced a ranked list. A mix policy was selected to " +
            "balance familiar comfort-zone picks with exploratory options.",
        bullets: [
            "City and cuisine type extracted from your message",
            "Comfort-zone candidates scored using affinity model",
            "Cross-city guard filtered irrelevant results",
            "Exploration candidates scored for novelty potential",
            "Mix policy balanced comfort vs. exploration ratio",
            "Final cards composed by the planner service",
        ],
    },
};

export class MockLLMAdapter implements LLMAdapter {
    readonly modelInfo: LLMModelInfo = MOCK_MODEL_INFO;
    private mode: MockMode;

    constructor(mode?: MockMode) {
        this.mode = mode ?? (process.env.LLM_MOCK_MODE as MockMode | undefined) ?? "short";
    }

    async generateStructuredJSON<T>(input: LLMGenerateInput): Promise<LLMGenerateOutput<T>> {
        if (this.mode === "error") {
            throw new Error("[MockLLMAdapter] Simulated adapter error (LLM_MOCK_MODE=error)");
        }

        const response = MOCK_RESPONSES[this.mode];

        const callTrace: LLMCallTrace = {
            model: this.modelInfo,
            temperature: input.temperature,
            prompt_version: input.promptVersion,
            latency_ms: 0,
            usage: ZERO_USAGE,
            fallback_used: false,
        };

        return {
            data: response as unknown as T,
            usage: ZERO_USAGE,
            callTrace,
        };
    }
}
