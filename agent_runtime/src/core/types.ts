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
}

/** Final output from the orchestrator, returned to the /run endpoint. */
export interface OrchestratorOutput {
    ok: boolean;
    city: string | null;
    type: string;
    cards: unknown;
    mix_policy: unknown;
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
    user_id: string;
    city: string;
    tags: string[];
    intent?: string;
    memory_confidence?: number;
}

/** Input to the rerank skill. */
export interface RerankInput {
    cz_ranked: unknown[];
    ez_ranked: unknown[];
    user_id: string;
    user_city: string;
    user_tags: string[];
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
