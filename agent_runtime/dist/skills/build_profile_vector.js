"use strict";
/**
 * build_profile_vector skill — P4 dynamic weighting unification
 *
 * Transforms memory.search weighted results into a deterministic profile
 * vector and per-memory weight breakdown.  This is the SINGLE authoritative
 * source for dynamic weighting in the runtime pipeline.  No other node may
 * recompute time/sentiment weights.
 *
 * Weight formulas (all deterministic):
 *   w_time    = exp(-LAMBDA_TIME * delta_days)
 *               delta_days = (now_ms - timestamp_ms) / 86400000
 *               Falls back to 1.0 when timestamp is absent or unparseable.
 *   w_sent    = clamp(1 + ALPHA_SENT * sentiment, W_SENT_MIN, W_SENT_MAX)
 *               Falls back to 1.0 when sentiment is absent.
 *   w_context = passed through from memory.search (no re-computation).
 *   final_weight = cosine * w_time * w_sent * w_context
 *
 * Profile vector:
 *   Weighted average of MemoryUnit.embedding (512-dim) using final_weight /
 *   total_weight normalization.  Returns a deterministic 512-dim zero vector
 *   when no embeddings are supplied (typical — memory.search does not return
 *   raw embeddings in standard mode).
 *
 * Determinism contract:
 *   - Given identical input + nowMs → identical output.
 *   - All floats rounded to 6 decimal places.
 *   - Anchors sorted by final_weight desc, memory_id asc (tie-break).
 *   - No Date.now() in decision logic; nowMs comes from ExecutionContext.
 *   - No side effects, no DB writes, no randomness.
 *
 * Decision trace:
 *   output.decision_trace = { profile_vector_node: ProfileVectorDecisionTrace }
 *   The orchestrator's mergeResultTraceBundles picks this up and writes it to
 *   ctx.decision_trace.profile_vector_node so explain_from_trace can read it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildProfileVector = buildProfileVector;
exports.createBuildProfileVectorSkill = createBuildProfileVectorSkill;
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const RULE_ID = "profile_vector_v1";
const SCHEMA_VERSION = "1.0";
const PROFILE_VECTOR_DIM = 512;
const TOP_K = 3;
const FIXED_EPOCH_MS = 0;
const ANCHOR_GATE_COSINE_THRESHOLD = 0.08;
const ANCHOR_GATE_RELATIVE_RATIO = 0.25;
/** Per-day time-decay rate for w_time = exp(-LAMBDA_TIME * delta_days). */
const LAMBDA_TIME = 0.1;
/** Sentiment scale for w_sent = 1 + ALPHA_SENT * sentiment. */
const ALPHA_SENT = 0.2;
/** Floor and cap for w_sent. */
const W_SENT_MIN = 0.5;
const W_SENT_MAX = 2.0;
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function round6(x) {
    return Number(x.toFixed(6));
}
function clamp(x, lo, hi) {
    if (!Number.isFinite(x))
        return lo;
    return Math.min(hi, Math.max(lo, x));
}
/**
 * w_time = exp(-LAMBDA_TIME * delta_days).
 * delta_days = max(0, (nowMs - tsMs) / 86400000).
 * Returns 1.0 when timestamp is absent, zero, or unparseable.
 */
function computeWTime(timestamp, nowMs) {
    if (timestamp === undefined || timestamp === null)
        return 1.0;
    const tsMs = typeof timestamp === "number"
        ? timestamp
        : Date.parse(String(timestamp));
    if (!Number.isFinite(tsMs) || tsMs <= 0)
        return 1.0;
    const deltaDays = Math.max(0, (nowMs - tsMs) / 86400000);
    return round6(Math.exp(-LAMBDA_TIME * deltaDays));
}
/**
 * w_sent = clamp(1 + ALPHA_SENT * sentiment, W_SENT_MIN, W_SENT_MAX).
 * sentiment in [-1, 1].  Returns 1.0 when absent.
 */
function computeWSent(sentiment) {
    const s = typeof sentiment === "number" && Number.isFinite(sentiment)
        ? sentiment
        : 0;
    return round6(clamp(1 + ALPHA_SENT * s, W_SENT_MIN, W_SENT_MAX));
}
/**
 * Pure function: compute profile vector + weight breakdown from MemoryUnit[].
 *
 * @param memories  Memory records from memory.search (MemoryUnit[]).
 * @param nowMs     Reference epoch timestamp in milliseconds.
 * @returns         Deterministic profile vector, anchors, and weights.
 */
function buildProfileVector(memories, nowMs) {
    if (!Array.isArray(memories) || memories.length === 0) {
        return {
            profile_vector: new Array(PROFILE_VECTOR_DIM).fill(0),
            anchors: [],
            total_memories_considered: 0,
            weights: {
                per_memory: [],
                summary: {
                    dominant_reason: "none",
                    time_bias: 0,
                    sentiment_bias: 0,
                    context_bias: 0,
                },
            },
            has_embeddings: false,
            anchor_gate: {
                enabled: true,
                cosine_threshold: ANCHOR_GATE_COSINE_THRESHOLD,
                relative_ratio: ANCHOR_GATE_RELATIVE_RATIO,
                candidates_before: 0,
                candidates_after: 0,
                dropped_count: 0,
            },
        };
    }
    // ── 1. Compute per-memory weights ────────────────────────────────────────
    const perMemory = memories.map((m) => {
        const cosine = round6(clamp(m.cosine ?? 0, 0, 1));
        const wTime = computeWTime(m.timestamp, nowMs);
        const wSent = computeWSent(m.sentiment);
        const wContext = round6(clamp(m.w_context ?? 1, 0, 1));
        const finalWeight = round6(clamp(cosine, 0, 1) *
            clamp(wTime, 0, 1) *
            clamp(wSent, 0, W_SENT_MAX) *
            clamp(wContext, 0, 1));
        return {
            memory_id: String(m.memory_id ?? ""),
            cosine,
            w_time: wTime,
            w_sent: wSent,
            w_context: wContext,
            final_weight: finalWeight,
        };
    });
    // ── 2. Sort: final_weight desc, memory_id asc (deterministic tie-break) ──
    const sorted = [...perMemory].sort((a, b) => {
        if (b.final_weight !== a.final_weight)
            return b.final_weight - a.final_weight;
        return a.memory_id.localeCompare(b.memory_id);
    });
    const anchorCandidatesBefore = sorted.length;
    const absolutePassed = sorted.filter((m) => m.cosine >= ANCHOR_GATE_COSINE_THRESHOLD);
    const topCosine = absolutePassed.reduce((mx, m) => Math.max(mx, m.cosine), 0);
    const relativeThreshold = topCosine * ANCHOR_GATE_RELATIVE_RATIO;
    const gated = absolutePassed.filter((m) => m.cosine >= relativeThreshold);
    const anchorCandidatesAfter = gated.length;
    const anchorDroppedCount = anchorCandidatesBefore - anchorCandidatesAfter;
    const anchors = gated.slice(0, TOP_K);
    // ── 3. Summary statistics over ALL memories ───────────────────────────────
    const n = perMemory.length;
    const timeBias = round6(perMemory.reduce((s, p) => s + p.w_time, 0) / n);
    const sentimentBias = round6(perMemory.reduce((s, p) => s + p.w_sent, 0) / n);
    const contextBias = round6(perMemory.reduce((s, p) => s + p.w_context, 0) / n);
    // Dominant reason: whichever factor deviates most from 1.0
    const biasDevs = [
        { name: "time", dev: Math.abs(timeBias - 1) },
        { name: "sentiment", dev: Math.abs(sentimentBias - 1) },
        { name: "context", dev: Math.abs(contextBias - 1) },
    ].sort((a, b) => b.dev - a.dev || a.name.localeCompare(b.name));
    const topBias = biasDevs[0];
    const dominantReason = topBias && topBias.dev > 0.001 ? topBias.name : "balanced";
    // ── 4. Profile vector: weighted average of embeddings ────────────────────
    const memoriesWithEmbeddings = memories.filter((m) => Array.isArray(m.embedding) &&
        m.embedding.length === PROFILE_VECTOR_DIM);
    const has_embeddings = memoriesWithEmbeddings.length > 0;
    let profile_vector;
    if (anchors.length === 0) {
        profile_vector = new Array(PROFILE_VECTOR_DIM).fill(0);
    }
    else if (has_embeddings) {
        const weightById = new Map(sorted.map((p) => [p.memory_id, p.final_weight]));
        const totalWeight = memoriesWithEmbeddings.reduce((s, m) => s + (weightById.get(String(m.memory_id ?? "")) ?? 0), 0);
        if (totalWeight > 0) {
            const vec = new Array(PROFILE_VECTOR_DIM).fill(0);
            for (const m of memoriesWithEmbeddings) {
                if (!Array.isArray(m.embedding) || m.embedding.length !== PROFILE_VECTOR_DIM)
                    continue;
                const w = weightById.get(String(m.memory_id ?? "")) ?? 0;
                for (let i = 0; i < PROFILE_VECTOR_DIM; i++) {
                    const current = vec[i] ?? 0;
                    const value = m.embedding[i] ?? 0;
                    vec[i] = current + (w / totalWeight) * value;
                }
            }
            profile_vector = vec.map((v) => round6(v));
        }
        else {
            profile_vector = new Array(PROFILE_VECTOR_DIM).fill(0);
        }
    }
    else {
        profile_vector = new Array(PROFILE_VECTOR_DIM).fill(0);
    }
    return {
        profile_vector,
        anchors,
        total_memories_considered: memories.length,
        weights: {
            per_memory: sorted,
            summary: {
                dominant_reason: dominantReason,
                time_bias: timeBias,
                sentiment_bias: sentimentBias,
                context_bias: contextBias,
            },
        },
        has_embeddings,
        anchor_gate: {
            enabled: true,
            cosine_threshold: ANCHOR_GATE_COSINE_THRESHOLD,
            relative_ratio: ANCHOR_GATE_RELATIVE_RATIO,
            candidates_before: anchorCandidatesBefore,
            candidates_after: anchorCandidatesAfter,
            dropped_count: anchorDroppedCount,
        },
    };
}
// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------
function createBuildProfileVectorSkill() {
    return {
        name: "build_profile_vector",
        inputSchema: {
            description: "Compute profile vector from memory.search weighted results (P4 unification)",
            required: [],
            optional: ["weighted_results", "now_ts", "decision_trace"],
        },
        outputSchema: {
            description: "Profile vector (512-dim), anchors, per-memory weights, and decision trace",
            required: [
                "profile_vector",
                "anchors",
                "total_memories_considered",
                "weights",
                "decision_trace",
            ],
        },
        async execute(input, context) {
            let nowMs = FIXED_EPOCH_MS;
            let nowSource = "fixed_epoch";
            if (typeof input.now_ts === "number" && Number.isFinite(input.now_ts)) {
                nowMs = input.now_ts;
                nowSource = "input_now_ts";
            }
            else if (typeof context.request_ts === "number" &&
                Number.isFinite(context.request_ts)) {
                nowMs = context.request_ts;
                nowSource = "context_request_ts";
            }
            const weighted = Array.isArray(input.weighted_results)
                ? input.weighted_results
                : [];
            // ── Empty input: deterministic fallback ───────────────────────────
            if (weighted.length === 0) {
                const fallbackTrace = {
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    now_source: nowSource,
                    anchors: [],
                    weights_summary: {
                        dominant_reason: "none",
                        time_bias: 0,
                        sentiment_bias: 0,
                        context_bias: 0,
                    },
                    total_memories_considered: 0,
                    profile_vector_dim: PROFILE_VECTOR_DIM,
                    has_embeddings: false,
                    fallback_used: true,
                    fallback_reason: "empty_input",
                    anchor_gate_enabled: true,
                    anchor_gate_cosine_threshold: ANCHOR_GATE_COSINE_THRESHOLD,
                    anchor_gate_relative_ratio: ANCHOR_GATE_RELATIVE_RATIO,
                    anchor_candidates_before: 0,
                    anchor_candidates_after: 0,
                    anchor_dropped_count: 0,
                };
                const fallbackOutput = {
                    profile_vector: new Array(PROFILE_VECTOR_DIM).fill(0),
                    anchors: [],
                    total_memories_considered: 0,
                    weights: {
                        per_memory: [],
                        summary: {
                            dominant_reason: "none",
                            time_bias: 0,
                            sentiment_bias: 0,
                            context_bias: 0,
                        },
                    },
                    decision_trace: { profile_vector_node: fallbackTrace },
                };
                return { output: fallbackOutput, trace: fallbackTrace };
            }
            // ── Compute ───────────────────────────────────────────────────────
            // MemoryWeightedResult is structurally compatible with MemoryUnit
            const memories = weighted;
            const result = buildProfileVector(memories, nowMs);
            const pvTrace = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                now_source: nowSource,
                anchors: result.anchors,
                weights_summary: result.weights.summary,
                total_memories_considered: result.total_memories_considered,
                profile_vector_dim: PROFILE_VECTOR_DIM,
                has_embeddings: result.has_embeddings,
                fallback_used: false,
                anchor_gate_enabled: result.anchor_gate.enabled,
                anchor_gate_cosine_threshold: result.anchor_gate.cosine_threshold,
                anchor_gate_relative_ratio: result.anchor_gate.relative_ratio,
                anchor_candidates_before: result.anchor_gate.candidates_before,
                anchor_candidates_after: result.anchor_gate.candidates_after,
                anchor_dropped_count: result.anchor_gate.dropped_count,
            };
            const output = {
                profile_vector: result.profile_vector,
                anchors: result.anchors,
                total_memories_considered: result.total_memories_considered,
                weights: result.weights,
                decision_trace: { profile_vector_node: pvTrace },
            };
            // The orchestrator's mergeResultTraceBundles will pick up
            // output.decision_trace = { profile_vector_node: pvTrace } and write
            // it to ctx.decision_trace.profile_vector_node automatically.
            return { output, trace: pvTrace };
        },
    };
}
//# sourceMappingURL=build_profile_vector.js.map