"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=llm_adapter.js.map