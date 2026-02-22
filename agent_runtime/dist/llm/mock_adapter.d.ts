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
import { LLMAdapter, LLMModelInfo, LLMGenerateInput, LLMGenerateOutput } from "./llm_adapter";
export type MockMode = "short" | "long" | "error";
export declare class MockLLMAdapter implements LLMAdapter {
    readonly modelInfo: LLMModelInfo;
    private mode;
    constructor(mode?: MockMode);
    generateStructuredJSON<T>(input: LLMGenerateInput): Promise<LLMGenerateOutput<T>>;
}
//# sourceMappingURL=mock_adapter.d.ts.map