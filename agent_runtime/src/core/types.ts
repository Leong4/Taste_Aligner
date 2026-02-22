/**
 * Core type definitions for the SkillRegistry + Graph orchestration architecture.
 *
 * These types define the contract between Skills, the Graph, the Orchestrator,
 * and the ExecutionContext. All deterministic decision logic flows through
 * these interfaces without any multi-agent reasoning.
 */

// ---------------------------------------------------------------------------
// Skill types
// ---------------------------------------------------------------------------

/** Schema descriptor for skill input/output validation. */
export interface SchemaDescriptor {
    /** Human-readable description of what this schema represents. */
    description: string;
    /** Required field names. */
    required: string[];
    /** Optional field names. */
    optional?: string[];
}

/** Trace fragment produced by a single skill execution. */
export type SkillTrace = Record<string, unknown>;

/** Result returned by every skill execution. */
export interface SkillResult<T = unknown> {
    output: T;
    trace: SkillTrace;
    /**
     * If true, the orchestrator stops the pipeline after this node.
     * The skill decides termination — the orchestrator does NOT
     * inspect node IDs or output shapes.
     */
    terminal?: boolean;
    /** Human-readable reason for early termination. */
    terminalReason?: string;
}

/** A registered skill that can be executed by the Orchestrator. */
export interface Skill<TInput = unknown, TOutput = unknown> {
    /** Unique skill identifier (e.g. "extract_intent", "recall_candidates"). */
    name: string;
    /** Describes expected input shape. */
    inputSchema: SchemaDescriptor;
    /** Describes expected output shape. */
    outputSchema: SchemaDescriptor;
    /** Execute the skill with resolved input from the ExecutionContext. */
    execute(input: TInput, context: ExecutionContext): Promise<SkillResult<TOutput>>;
}

// ---------------------------------------------------------------------------
// Graph types
// ---------------------------------------------------------------------------

/** A single node in the execution graph. */
export interface GraphNode {
    /** Unique node identifier. */
    id: string;
    /** Name of the skill to execute at this node. */
    skill: string;
    /**
     * Declares where this node's input comes from.
     * - Key: input field name expected by the skill
     * - Value: source path in the form "node_id.field" or "input.field"
     *   where "input" refers to the original orchestrator input.
     */
    inputFrom: Record<string, string>;
}

/** A directed acyclic graph defining execution order and data flow. */
export interface GraphDefinition {
    /** Human-readable graph name. */
    name: string;
    /** Version string for tracking graph schema changes. */
    version: string;
    /** Ordered list of nodes to execute. For a linear graph, execution is sequential. */
    nodes: GraphNode[];
    /**
     * Declares which output fields to extract from the final node's
     * output to build OrchestratorOutput. Keys map to OrchestratorOutput
     * fields; values are dot-paths into the last executed node's output.
     *
     * This lets the orchestrator assemble the response without
     * hardcoding any node IDs.
     */
    outputMapping?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ExecutionContext types
// ---------------------------------------------------------------------------

/** The shared execution context maintained by the Orchestrator across all skill invocations. */
export interface ExecutionContext {
    /** Original input provided to the orchestrator. */
    input: OrchestratorInput;
    /** Request timestamp fixed once per orchestrator run (ms epoch). */
    request_ts: number;
    /** Intermediate results keyed by node ID. */
    intermediate_results: Record<string, unknown>;
    /** Final result after all nodes complete. */
    final_result: unknown | null;
    /** Merged decision trace from all skill executions. */
    decision_trace: Record<string, SkillTrace>;
    /** Errors collected during execution (non-fatal). */
    errors: ExecutionError[];
    /** Timing metadata. */
    timing: Record<string, number>;
}

/** An error that occurred during skill execution. */
export interface ExecutionError {
    node_id: string;
    skill: string;
    code: string;
    message: string;
    timestamp: number;
}

// ---------------------------------------------------------------------------
// Orchestrator I/O types
// ---------------------------------------------------------------------------

/** Input to the orchestrator from the /run endpoint. */
export interface OrchestratorInput {
    /** Raw user text. */
    text: string;
    /** User identifier (defaults to "u001"). */
    user_id?: string;
    /** Optional fixed request timestamp in ms epoch for deterministic skills. */
    request_ts?: number;
}

/** Final output from the orchestrator, returned to the /run endpoint. */
export interface OrchestratorOutput {
    ok: boolean;
    city: string | null;
    type: string;
    cards: unknown;
    mix_policy: unknown;
    explanation?: string;
    bullets?: string[];
    decision_trace: Record<string, SkillTrace>;
    errors: ExecutionError[];
    timing: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Skill-specific I/O types
// ---------------------------------------------------------------------------

/** Output of the extract_intent skill. */
export interface ExtractIntentOutput {
    city: string | null;
    type: "food" | "culture" | "mixed" | "unknown";
    tags: string[];
    cz_seed: string[];
    ez_seed: string[];
    raw_text: string;
    confidence: number;
    user_id: string;
}

/** Input to the fetch_recommendation skill (was recall_candidates). */
export interface FetchRecommendationInput {
    user_id?: string;
    city?: string;
    tags?: string[];
    /** Fallback tags from extract_intent when tag_expand is unavailable. */
    intent_tags?: string[];
    intent?: unknown;
    meta?: Record<string, unknown>;
    controls?: Record<string, unknown>;
    memory_confidence?: number;
}

/** Input to the memory_signal skill. */
export interface MemorySignalInput {
    user_id?: string;
    city?: string | null;
    tags?: string[];
    /** Fallback tags from upstream if normalized tags are unavailable. */
    intent_tags?: string[];
    top_k?: number;
    /** Optional fixed timestamp in ms epoch. */
    now_ts?: number;
    mode?: "embedding" | "tag_fallback" | "auto";
    query_embedding?: number[];
}

/** Decision trace payload for memory_signal. */
export interface MemorySignalDecisionTrace extends Record<string, unknown> {
    rule_id: "memory_signal_v1";
    schema_version: "1.0";
    method: "embedding" | "tag_fallback" | "none";
    input_summary: {
        user_id: string;
        city: string | null;
        tags_count: number;
        tags_sample: string[];
        top_k: number;
        now_ts: number;
    };
    stats: {
        total_loaded?: number | null;
        total_scored?: number | null;
        returned: number;
        top_n_used: number;
    };
    aggregation: {
        confidence_formula: string;
        top_n_used: number;
        confidence_components: {
            top_score_avg: number;
            coverage: number;
        };
    };
    weights: {
        lambda_time?: number | null;
        alpha_sent?: number | null;
    };
    fallback_used: boolean;
    fallback_reason?: "no_tags" | "empty_results" | "tool_error" | "invalid_output";
    error_message?: string;
    latency_ms: number;
}

/** Output of the memory_signal skill. */
export interface MemorySignalOutput {
    anchor_memory_ids: string[];
    anchor_tags: string[];
    memory_confidence: number;
    memory_results?: Array<Record<string, unknown>>;
    decision_trace: {
        memory_signal: MemorySignalDecisionTrace;
    };
}

/** Input to the tes_builder skill. */
export interface TesBuilderInput {
    anchor_tags?: string[];
    request_ts?: number | string;
    user_city?: string;
    decision_trace?: Record<string, unknown>;
}

/** Decision trace payload for tes_builder. */
export interface TesBuilderDecisionTrace extends Record<string, unknown> {
    rule_id: "tes_builder_v1";
    schema_version: "1.0";
    request_ts: number;
    input_summary: {
        anchor_tag_count: number;
        first_5_tags: string[];
    };
    tool: {
        name: string;
        endpoint: string;
    };
    backend: string;
    tes_version: string;
    latency_ms: number;
    vector_checks: {
        dim_expected: 512;
        dim_actual: number;
        finite: boolean;
        norm: number | null;
    };
    fallback_used: boolean;
    fallback_reason?: "no_tags" | "tool_error" | "invalid_output" | "invalid_vector";
    error_message?: string;
}

/** Output of the tes_builder skill. */
export interface TesBuilderOutput {
    tes_vector: number[];
    tes_dim: number;
    normalized: boolean;
    backend: string;
    tes_version: string;
    input_anchor_tags: string[];
    used_anchor_tags: string[];
    fallback_used: boolean;
    fallback_reason?: "no_tags" | "tool_error" | "invalid_output" | "invalid_vector";
    decision_trace: Record<string, unknown>;
}

/** Output of the fetch_recommendation skill. */
export interface FetchRecommendationOutput {
    cz_ranked: unknown[];
    ez_ranked: unknown[];
    /** Backward-compatible field used by downstream graph nodes. */
    mix_policy: Record<string, unknown> | null;
    /** Backward-compatible field used by downstream graph nodes. */
    decision_trace: Record<string, unknown>;
    /** Explicit aliases for clearer contracts. */
    reco_mix_policy?: Record<string, unknown> | null;
    reco_decision_trace?: Record<string, unknown>;
}

/** Input to the rerank skill. */
export interface RerankInput {
    cz_ranked: unknown[];
    ez_ranked: unknown[];
    user_id: string;
    user_city: string;
    user_tags: string[];
    /** User TES vector from tes_builder (512-dim, normalized). */
    tes_vector?: number[];
    /** Dimension of the TES vector. */
    tes_dim?: number;
    /** Whether the TES vector is L2-normalized. */
    tes_normalized?: boolean;
    /** Whether the tes_builder indicated fallback. */
    tes_fallback_used?: boolean;
}

/** Decision trace for TES-driven rerank. */
export interface RerankTesDecisionTrace extends Record<string, unknown> {
    rule_id: "rerank_v2_tes";
    schema_version: "1.0";
    tes_used: boolean;
    tes_budget: {
        max_calls: number;
        used_calls: number;
        cache_hits: number;
    };
    weights: {
        tes_sim_weight: number;
    };
    stats: {
        cz_items: number;
        ez_items: number;
        tes_scored_items: number;
        invalid_vectors: number;
        tool_errors: number;
    };
    input_summary: {
        user_tes_dim: number;
        user_tes_valid: boolean;
        cz_count: number;
        ez_count: number;
    };
    fallback_used: boolean;
    fallback_reason?: "no_user_tes" | "zero_budget" | "no_candidates";
    latency_ms?: number;
}

/** Output of the rerank skill. */
export interface RerankOutput {
    cz_ranked: unknown[];
    ez_ranked: unknown[];
}

/** Input to the mix_policy skill. */
export interface MixPolicyInput {
    cz_ranked: unknown[];
    ez_ranked: unknown[];
    intent: string;
    memory_confidence: number;
    /** Mix policy from the recommendation service (graph input). */
    reco_mix_policy?: Record<string, unknown>;
    /** Decision trace from the recommendation service (graph input). */
    reco_decision_trace?: Record<string, unknown>;
}

/** Input to the explain_from_trace skill. */
export interface ExplainFromTraceInput {
    /** The merged decision_trace accumulated so far. */
    decision_trace: Record<string, unknown>;
    /** Original user text (optional context). */
    user_text?: string;
    /** Locale for the explanation. */
    locale?: "en" | "zh";
    /** Style of explanation. */
    style?: "concise" | "detailed";
}

/** Output of the explain_from_trace skill. */
export interface ExplainFromTraceOutput {
    explanation: string;
    bullets: string[];
    meta: { locale: string; style: string };
}

/** Input to the decide_tag_budget skill. */
export interface DecideTagBudgetInput {
    /** Tags extracted from user text. */
    tags: string[];
    /** Comfort-zone seed items. */
    cz_seed: string[];
    /** Exploration-zone seed items. */
    ez_seed: string[];
    /** Detected intent type. */
    type: string;
    /** Original raw user text (for soft hint detection). */
    raw_text: string;
    /** Intent confidence score. */
    confidence: number;
}

/** Confidence thresholds for tag expansion. */
export interface TagBudgetThresholds {
    /** Minimum confidence for soft (hint-based) expansion. 0.65 if budget>=9, else 0.55. */
    min_confidence_soft: number;
    /** Minimum confidence for hard (seed-based) expansion. Always 0.55. */
    min_confidence_hard: number;
}

/** Feature vector used in budget computation. */
export interface TagBudgetFeatures {
    /** Number of whitespace-delimited tokens in raw_text. */
    token_count: number;
    /** Number of hard seeds (cz_seed + ez_seed). */
    hard_seed_count: number;
    /** Number of soft hint keywords matched. */
    soft_hint_count: number;
    /** Detected intent type. */
    type: string;
}

/** Output of the decide_tag_budget skill. */
export interface DecideTagBudgetOutput {
    /** Total expansion budget (clamped 4–10). */
    budget: number;
    /** Max slots for hard (seed-based) expansion. */
    hard_expand_limit: number;
    /** Max slots for soft (hint-based) expansion. */
    soft_expand_limit: number;
    /** Confidence thresholds for downstream tag_expand. */
    thresholds: TagBudgetThresholds;
    /** Feature vector used in computation. */
    features: TagBudgetFeatures;
    /** Deterministic explanation reasons (stable ordering). */
    reasons: string[];
    /** Number of hard seeds counted. */
    hard_seed_count: number;
    /** Number of soft hints detected. */
    soft_hint_count: number;
    /** Soft hint keywords that matched (sorted alphabetically). */
    soft_hints_detected: string[];
    /** Type bonus applied. */
    type_bonus: number;
    /** Length bonus applied. */
    length_bonus: number;
    /** Pass-through: tags from extract_intent. */
    tags: string[];
    /** Pass-through: cz_seed from extract_intent. */
    cz_seed: string[];
    /** Pass-through: ez_seed from extract_intent. */
    ez_seed: string[];
}

/** Input to the tag_expand skill. */
export interface TagExpandInput {
    user_text: string;
    intent: {
        tags?: string[];
        type?: string;
    };
    tag_budget: {
        budget: number;
        hard_expand_limit: number;
        soft_expand_limit: number;
        thresholds: TagBudgetThresholds;
    };
}

/** A single LLM expansion candidate tag. */
export interface TagExpansionCandidate {
    tag: string;
    confidence: number;
}

/** LLM output schema for tag expansion. */
export interface TagExpandLLMOutput {
    hard_expansions: TagExpansionCandidate[];
    soft_expansions: TagExpansionCandidate[];
}

/** Output of the tag_expand skill. */
export interface TagExpandOutput {
    tags_seed: string[];
    tags_added: string[];
    tags_dropped: Array<{
        tag: string;
        kind: "hard" | "soft";
        confidence: number;
        reason: string;
    }>;
    tags_final: string[];
}

/** Input to the tag_normalize skill. */
export interface TagNormalizeInput {
    tags_final: string[];
    intent: {
        city?: string;
        type?: string;
        tags?: string[];
    };
}

/** Output of the tag_normalize skill. */
export interface TagNormalizeOutput {
    normalized_tags: string[];
    mapping: Array<{
        original: string;
        normalized: string;
    }>;
    dropped: Array<{
        original: string;
        reason: string;
    }>;
    decision_trace: {
        tag_normalize: {
            rule_id: "tag_normalize_v1";
            schema_version: "1.0";
            mapping: Record<string, string>;
            dropped: Record<string, string>;
            normalized_tags: string[];
        };
    };
}

// ---------------------------------------------------------------------------
// memory_weight_adjust types
// ---------------------------------------------------------------------------

/** Input to the memory_weight_adjust skill. */
export interface MemoryWeightAdjustInput {
    user_id?: string;
    city?: string | null;
    tags?: string[];
    intent_tags?: string[];
    top_k?: number;
    now_ts?: number;
}

/** A single weighted memory result. */
export interface MemoryWeightedResult {
    memory_id: string;
    score: number;
    cosine?: number;
    w_time?: number;
    w_sent?: number;
    w_context?: number;
    city_boost?: number;
    tag_boost?: number;
    timestamp?: string | number;
    city?: string;
    normalized_tags?: string[];
    sentiment?: number;
}

/** Output of the memory_weight_adjust skill. */
export interface MemoryWeightAdjustOutput {
    weighted_results: MemoryWeightedResult[];
    anchor_memory_ids: string[];
    anchor_tags: string[];
    memory_confidence: number;
    stats: {
        input_tags_count: number;
        results_count: number;
        anchor_count: number;
        anchor_tags_count: number;
    };
    decision_trace: {
        memory_weight_adjust: MemoryWeightAdjustDecisionTrace;
    };
}

/** Decision trace payload for memory_weight_adjust. */
export interface MemoryWeightAdjustDecisionTrace extends Record<string, unknown> {
    rule_id: "memory_weight_adjust_v1";
    schema_version: "1.0";
    tool: { name: "memory.search"; timeout_ms?: number };
    input_summary: {
        user_id_present: boolean;
        city?: string;
        tags_count: number;
        top_k: number;
        now_ts_present: boolean;
    };
    aggregation: {
        anchor_top_n: number;
        confidence_formula: string;
    };
    fallback_used: boolean;
    fallback_reason?: "no_tags" | "tool_error" | "invalid_output" | "empty_results";
    error_message?: string;
    latency_ms?: number;
}

/** Input to the build_cards skill. */
export interface BuildCardsInput {
    city: string;
    user_id: string;
    tags: string[];
    cz_ranked: unknown[];
    ez_ranked: unknown[];
    mix_policy: Record<string, unknown>;
    cz_seed: string[];
    ez_seed: string[];
    intent: Record<string, unknown>;
    decision_trace: Record<string, unknown>;
}
