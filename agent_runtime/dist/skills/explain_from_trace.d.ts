/**
 * ExplainFromTrace skill — generates a human-readable explanation of
 * the recommendation decision by summarizing the accumulated
 * decision_trace via an LLM adapter.
 *
 * This is the first LLM-backed skill in the pipeline. It runs AFTER
 * build_cards and does not alter any recommendation data — it only
 * produces an additive explanation layer.
 *
 * The skill:
 *   1. Compacts the decision_trace into a concise prompt (no raw arrays)
 *   2. Calls the LLM adapter for structured JSON output
 *   3. Returns explanation + bullets + full call trace for auditing
 *   4. On adapter failure, returns a graceful fallback (never throws)
 *
 * The adapter factory defaults to mock. Start with
 * `./scripts/dev_restart.sh --all --with-llm` to use the real openai_compat adapter.
 */
import { Skill, ExplainFromTraceInput, ExplainFromTraceOutput } from "../core/types";
import { LLMAdapter } from "../llm/llm_adapter";
export declare function createExplainFromTraceSkill(adapter: LLMAdapter): Skill<ExplainFromTraceInput, ExplainFromTraceOutput>;
//# sourceMappingURL=explain_from_trace.d.ts.map