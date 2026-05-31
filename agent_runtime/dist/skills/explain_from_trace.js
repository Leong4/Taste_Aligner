"use strict";
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
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createExplainFromTraceSkill = createExplainFromTraceSkill;
const explain_from_trace_v1_1 = require("../llm/prompts/explain_from_trace_v1");
// ---------------------------------------------------------------------------
// Deterministic inputs_used order — matches compactTrace output keys
// ---------------------------------------------------------------------------
// "profile" maps to compact.profile (from decision_trace.profile_vector_node).
// Explain reads ONLY the unified profile_vector_node — no raw memory weights
// must be re-read or recomputed from other trace keys.
const INPUT_ORDER = ["intent", "recall", "rerank", "mix_policy", "profile", "planner"];
// ---------------------------------------------------------------------------
// Compaction limits
// ---------------------------------------------------------------------------
const MAX_CARDS = 6;
const MAX_ITEMS_PER_CARD = 3;
const MAX_TAGS_PER_ITEM = 5;
const MAX_COMPACT_JSON_BYTES = 8 * 1024; // 8 KB
/**
 * Token budget guard: if usage.total_tokens exceeds this threshold the skill
 * falls back deterministically with reason "token_budget_exceeded".
 * Configurable via EXPLAIN_MAX_TOTAL_TOKENS env var (default from LIMITS).
 */
const EXPLAIN_MAX_TOTAL_TOKENS = parseInt(process.env.EXPLAIN_MAX_TOTAL_TOKENS ?? String(explain_from_trace_v1_1.LIMITS.max_total_tokens), 10);
function isValidOutput(data) {
    if (!data || typeof data !== "object")
        return false;
    const d = data;
    if (typeof d.explanation !== "string" || d.explanation.trim().length === 0)
        return false;
    if (!Array.isArray(d.bullets))
        return false;
    if (d.bullets.length < 3 || d.bullets.length > 5)
        return false;
    if (!d.bullets.every((b) => typeof b === "string" && b.trim().length > 0))
        return false;
    return true;
}
// ---------------------------------------------------------------------------
// Local fallback output — deterministic, no LLM required
// ---------------------------------------------------------------------------
function buildLocalFallback(compact) {
    const intent = compact.intent;
    const city = typeof intent?.city === "string" ? intent.city : "your city";
    const type = typeof intent?.type === "string" ? intent.type : "food";
    return {
        explanation: `Based on your preferences, we selected ${type} options in ${city} matching your taste profile.`,
        bullets: [
            "Location matched from your input",
            "Candidates ranked by affinity score",
            "Mix policy applied for variety",
        ],
    };
}
// ---------------------------------------------------------------------------
// Trace compaction — extract salient fields for the prompt
// ---------------------------------------------------------------------------
function capArray(arr, max) {
    return arr.length <= max ? arr : arr.slice(0, max);
}
function capItemFields(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
        if (Array.isArray(v)) {
            out[k] = capArray(v, MAX_TAGS_PER_ITEM);
        }
        else if (typeof v === "string" && v.length > 120) {
            // Drop long text fields silently
        }
        else {
            out[k] = v;
        }
    }
    return out;
}
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
function toNumber4(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n))
        return undefined;
    return Number(n.toFixed(4));
}
function extractWeightedResultIndex(trace) {
    const index = new Map();
    const mwa = asObject(trace.memory_weight_adjust);
    const weighted = mwa?.weighted_results;
    if (!Array.isArray(weighted))
        return index;
    for (const row of weighted) {
        const obj = asObject(row);
        if (!obj)
            continue;
        const memoryId = typeof obj.memory_id === "string" ? obj.memory_id : "";
        if (!memoryId)
            continue;
        index.set(memoryId, obj);
    }
    return index;
}
function extractAnchorEvidence(trace) {
    const pvn = asObject(trace.profile_vector_node);
    if (!pvn || !Array.isArray(pvn.anchors))
        return [];
    const weightedIndex = extractWeightedResultIndex(trace);
    const evidence = [];
    for (const anchorRaw of pvn.anchors) {
        const anchor = asObject(anchorRaw);
        if (!anchor)
            continue;
        const memoryId = typeof anchor.memory_id === "string" ? anchor.memory_id : "";
        if (!memoryId)
            continue;
        const weighted = weightedIndex.get(memoryId);
        const rawTags = Array.isArray(weighted?.normalized_tags) ? weighted?.normalized_tags : [];
        const tags = rawTags
            .filter((t) => typeof t === "string" && t.trim().length > 0)
            .map((t) => t.trim().toLowerCase())
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
            .slice(0, 3);
        const row = {
            memory_id: memoryId,
            tags,
        };
        const wTime = toNumber4(anchor.w_time ?? weighted?.w_time);
        if (wTime !== undefined)
            row.w_time = wTime;
        const wSent = toNumber4(anchor.w_sent ?? weighted?.w_sent);
        if (wSent !== undefined)
            row.w_sent = wSent;
        const finalWeight = toNumber4(anchor.final_weight);
        if (finalWeight !== undefined)
            row.final_weight = finalWeight;
        const sentiment = toNumber4(weighted?.sentiment);
        if (sentiment !== undefined)
            row.sentiment = sentiment;
        if (typeof weighted?.timestamp === "string" && weighted.timestamp.trim()) {
            row.timestamp = weighted.timestamp.trim();
        }
        evidence.push(row);
    }
    evidence.sort((a, b) => {
        const aw = a.final_weight ?? -1;
        const bw = b.final_weight ?? -1;
        if (bw !== aw)
            return bw - aw;
        return a.memory_id.localeCompare(b.memory_id);
    });
    return evidence.slice(0, 3);
}
function hasProfileVectorNode(trace) {
    return asObject(trace.profile_vector_node) !== null;
}
function formatEvidenceLine(e) {
    const tags = e.tags.length > 0 ? e.tags.join("|") : "none";
    const wTime = e.w_time !== undefined ? String(e.w_time) : "n/a";
    const wSent = e.w_sent !== undefined ? String(e.w_sent) : "n/a";
    const finalWeight = e.final_weight !== undefined ? String(e.final_weight) : "n/a";
    return `memory_id=${e.memory_id}, tags=${tags}, w_time=${wTime}, w_sent=${wSent}, final_weight=${finalWeight}`;
}
function buildEvidenceBullets(evidence) {
    return evidence.slice(0, 2).map((e, i) => `Evidence ${i + 1}: ${formatEvidenceLine(e)}`);
}
function mergeBulletsWithEvidence(baseBullets, evidenceBullets) {
    const out = [];
    const seen = new Set();
    for (const b of [...evidenceBullets, ...baseBullets]) {
        const trimmed = b.trim();
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
        if (out.length >= 5)
            break;
    }
    while (out.length < 3) {
        out.push("Evidence-based ranking with deterministic weighting.");
    }
    return out.slice(0, 5);
}
function appendEvidenceToExplanation(explanation, evidenceBullets) {
    const trimmed = explanation.trim();
    const evidenceBlock = evidenceBullets.map((b, i) => `${i + 1}) ${b}`).join("\n");
    return `${trimmed}\n\nAnchor evidence:\n${evidenceBlock}`;
}
function buildAnchoredFallback(evidence) {
    const evidenceBullets = buildEvidenceBullets(evidence);
    return {
        explanation: "Recommendations are grounded in your recent uploaded memories. " +
            "The following anchor evidence was used deterministically.",
        bullets: mergeBulletsWithEvidence(["Profile vector and recall weights were applied consistently."], evidenceBullets),
    };
}
function buildInsufficientEvidenceFallback(anchorCount) {
    return {
        explanation: `Cold start: evidence is insufficient for a grounded explanation (anchors=${anchorCount}).`,
        bullets: [
            `Only ${anchorCount} anchor(s) are currently available from memory recall.`,
            "Upload more photos or provide richer captions to strengthen memory evidence.",
            "Current ranking falls back to intent, location, and baseline scoring signals.",
        ],
    };
}
function compactTrace(trace) {
    const compact = {};
    const anchorEvidence = extractAnchorEvidence(trace);
    // extract_intent summary
    const intent = trace.extract_intent;
    if (intent && typeof intent === "object") {
        const ei = intent;
        compact.intent = {
            city: ei.city,
            type: ei.type,
            tags: Array.isArray(ei.tags) ? capArray(ei.tags, MAX_TAGS_PER_ITEM) : ei.tags,
            confidence: ei.confidence,
        };
    }
    // fetch_recommendation / recall summary
    for (const key of ["fetch_recommendation", "recall", "recall_candidates"]) {
        const node = trace[key];
        if (node && typeof node === "object") {
            const n = node;
            compact.recall = {
                rule_id: n.rule_id,
                candidate_counts: n.candidate_counts,
                rules_used: n.rules_used,
            };
            break;
        }
    }
    // rerank summary — only top item ids and weights
    const rerank = trace.rerank;
    if (rerank && typeof rerank === "object") {
        const r = rerank;
        const topItems = r.top_items;
        let topIds = [];
        if (Array.isArray(topItems)) {
            topIds = capArray(topItems, MAX_ITEMS_PER_CARD)
                .map((item) => {
                if (typeof item === "object" && item !== null) {
                    const it = item;
                    return { id: it.id, score: it.score ?? it.score_CZ ?? it.score_EZ };
                }
                return item;
            });
        }
        compact.rerank = {
            rule_id: r.rule_id,
            weights: r.weights,
            top_items_preview: topIds,
        };
    }
    // mix_policy summary
    const mix = trace.mix_policy;
    if (mix && typeof mix === "object") {
        const m = mix;
        compact.mix_policy = {
            rule_id: m.rule_id,
            ratio: m.ratio,
            confidence: m.confidence,
        };
    }
    // profile_vector_node summary — P4 dynamic weighting unification.
    // explain_from_trace reads ONLY this unified structure; raw memory.search
    // weighting fields must NOT be re-read from other trace keys here.
    const pvn = trace.profile_vector_node;
    if (pvn && typeof pvn === "object" && !Array.isArray(pvn)) {
        const p = pvn;
        compact.profile = {
            anchors_count: Array.isArray(p.anchors) ? p.anchors.length : 0,
            anchor_evidence: anchorEvidence,
            weights_summary: p.weights_summary,
            total_memories_considered: p.total_memories_considered,
        };
    }
    // planner / build_cards summary — cap cards and items per card
    for (const key of ["planner", "build_cards"]) {
        const node = trace[key];
        if (node && typeof node === "object") {
            const n = node;
            const plannerCompact = {
                rule_id: n.rule_id,
                cards_count: n.cards_count,
            };
            // Capture all ez_fill variants the planner may emit
            if (n.ez_fill_triggered !== undefined)
                plannerCompact.ez_fill_triggered = n.ez_fill_triggered;
            if (n.ez_fill_reason !== undefined)
                plannerCompact.ez_fill_reason = n.ez_fill_reason;
            if (n.ez_fill_source !== undefined)
                plannerCompact.ez_fill_source = n.ez_fill_source;
            if (n.ez_fill !== undefined)
                plannerCompact.ez_fill = n.ez_fill;
            // Cap cards array
            if (Array.isArray(n.cards)) {
                plannerCompact.cards = capArray(n.cards, MAX_CARDS).map((card) => {
                    if (card && typeof card === "object") {
                        const c = card;
                        const cappedCard = {};
                        for (const [k, v] of Object.entries(c)) {
                            if (Array.isArray(v)) {
                                // Cap items per card, then cap tags per item
                                cappedCard[k] = capArray(v, MAX_ITEMS_PER_CARD).map((item) => {
                                    if (item && typeof item === "object") {
                                        return capItemFields(item);
                                    }
                                    return item;
                                });
                            }
                            else if (typeof v === "string" && v.length > 120) {
                                // Drop long text fields
                            }
                            else {
                                cappedCard[k] = v;
                            }
                        }
                        return cappedCard;
                    }
                    return card;
                });
            }
            compact.planner = plannerCompact;
            break;
        }
    }
    // 8 KB hard cap — deterministically remove largest fields first
    const enforceByteLimit = (obj) => {
        if (JSON.stringify(obj).length <= MAX_COMPACT_JSON_BYTES)
            return obj;
        // Priority order to drop: planner.cards first, then rerank.top_items_preview, then recall
        const result = { ...obj };
        const planner = result.planner;
        if (planner && planner.cards !== undefined) {
            const { cards: _cards, ...plannerWithout } = planner;
            result.planner = plannerWithout;
            if (JSON.stringify(result).length <= MAX_COMPACT_JSON_BYTES)
                return result;
        }
        const rerank = result.rerank;
        if (rerank && rerank.top_items_preview !== undefined) {
            const { top_items_preview: _tip, ...rerankWithout } = rerank;
            result.rerank = rerankWithout;
            if (JSON.stringify(result).length <= MAX_COMPACT_JSON_BYTES)
                return result;
        }
        if (result.recall !== undefined) {
            const { recall: _recall, ...withoutRecall } = result;
            if (JSON.stringify(withoutRecall).length <= MAX_COMPACT_JSON_BYTES)
                return withoutRecall;
        }
        return result;
    };
    return enforceByteLimit(compact);
}
// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------
function createExplainFromTraceSkill(adapter) {
    return {
        name: "explain_from_trace",
        inputSchema: {
            description: "Decision trace + optional user text for explanation generation",
            required: ["decision_trace"],
            optional: ["user_text", "locale", "style"],
        },
        outputSchema: {
            description: "Human-readable explanation with bullet points",
            required: ["explanation", "bullets", "meta"],
        },
        async execute(input, _context) {
            const locale = input.locale ?? process.env.EXPLAIN_LOCALE ?? "en";
            const style = input.style ?? process.env.EXPLAIN_STYLE ?? "concise";
            // Use graph-provided decision_trace, fall back to context
            const traceSource = input.decision_trace &&
                typeof input.decision_trace === "object" &&
                Object.keys(input.decision_trace).length > 0
                ? input.decision_trace
                : _context.decision_trace;
            const profileNodePresent = hasProfileVectorNode(traceSource);
            const anchorEvidence = extractAnchorEvidence(traceSource);
            const compact = compactTrace(traceSource);
            const userPrompt = (0, explain_from_trace_v1_1.buildUserPrompt)(compact, locale, style, input.user_text);
            let explanation;
            let bullets;
            let callTrace = null;
            let fallbackUsed = false;
            let fallbackReason = "";
            try {
                const result = await adapter.generateStructuredJSON({
                    systemPrompt: explain_from_trace_v1_1.SYSTEM_PROMPT,
                    userPrompt,
                    schema: explain_from_trace_v1_1.OUTPUT_JSON_SCHEMA,
                    temperature: explain_from_trace_v1_1.LIMITS.temperature,
                    promptVersion: explain_from_trace_v1_1.PROMPT_VERSION,
                    traceContext: compact,
                });
                callTrace = result.callTrace;
                // Token budget guardrail
                if (callTrace.usage.total_tokens > EXPLAIN_MAX_TOTAL_TOKENS) {
                    fallbackUsed = true;
                    fallbackReason = "token_budget_exceeded";
                    const local = buildLocalFallback(compact);
                    explanation = local.explanation;
                    bullets = local.bullets;
                }
                else if (!isValidOutput(result.data)) {
                    // Output schema validation
                    fallbackUsed = true;
                    fallbackReason = "invalid_output";
                    explanation = "Explanation unavailable.";
                    bullets = [];
                }
                else {
                    explanation = result.data.explanation;
                    bullets = result.data.bullets;
                    if (callTrace.fallback_used || adapter.fallbackReason) {
                        fallbackUsed = true;
                        fallbackReason = callTrace.fallback_reason ?? adapter.fallbackReason ?? "adapter_error";
                    }
                    if (profileNodePresent) {
                        if (anchorEvidence.length < 2) {
                            const local = buildInsufficientEvidenceFallback(anchorEvidence.length);
                            explanation = local.explanation;
                            bullets = local.bullets;
                        }
                        else {
                            const evidenceBullets = buildEvidenceBullets(anchorEvidence);
                            explanation = appendEvidenceToExplanation(explanation, evidenceBullets);
                            bullets = mergeBulletsWithEvidence(bullets, evidenceBullets);
                        }
                    }
                }
            }
            catch (err) {
                // Graceful fallback — never throw from this skill
                fallbackUsed = true;
                fallbackReason = "adapter_error";
                if (profileNodePresent) {
                    if (anchorEvidence.length >= 2) {
                        const local = buildAnchoredFallback(anchorEvidence);
                        explanation = local.explanation;
                        bullets = local.bullets;
                    }
                    else {
                        const local = buildInsufficientEvidenceFallback(anchorEvidence.length);
                        explanation = local.explanation;
                        bullets = local.bullets;
                    }
                }
                else {
                    explanation = "Explanation unavailable.";
                    bullets = [];
                }
                const adapterError = err instanceof Error ? err.message : String(err);
                callTrace = {
                    model: adapter.modelInfo,
                    temperature: explain_from_trace_v1_1.LIMITS.temperature,
                    prompt_version: explain_from_trace_v1_1.PROMPT_VERSION,
                    latency_ms: 0,
                    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                    fallback_used: true,
                    fallback_reason: "adapter_error",
                };
                console.warn(`[explain_from_trace] Adapter error, returning fallback: ${adapterError}`);
            }
            const output = {
                explanation,
                bullets,
                meta: { locale, style },
            };
            const trace = {
                schema_version: explain_from_trace_v1_1.PROMPT_VERSION,
                inputs_used: INPUT_ORDER.filter((k) => compact[k] != null),
                locale,
                style,
                fallback_used: fallbackUsed,
            };
            if (fallbackUsed) {
                trace.fallback_reason = fallbackReason || "adapter_error";
            }
            if (profileNodePresent) {
                trace.anchor_evidence_count = anchorEvidence.length;
                trace.evidence_status = anchorEvidence.length >= 2 ? "anchored" : "insufficient";
                if (anchorEvidence.length > 0) {
                    trace.anchor_evidence = anchorEvidence.slice(0, 2);
                }
            }
            if (callTrace) {
                const llmCallEntry = {
                    provider: callTrace.model.provider,
                    model_name: callTrace.model.model_name,
                    model_version: callTrace.model.version,
                    temperature: callTrace.temperature,
                    prompt_version: callTrace.prompt_version,
                    usage: callTrace.usage,
                    fallback_used: callTrace.fallback_used,
                };
                const llmFallbackReason = callTrace.fallback_reason ?? (fallbackUsed ? (fallbackReason || "adapter_error") : undefined);
                if (llmFallbackReason !== undefined) {
                    llmCallEntry.fallback_reason = llmFallbackReason;
                }
                trace.llm_call = llmCallEntry;
            }
            if (fallbackUsed && (fallbackReason || "adapter_error") === "adapter_error") {
                trace.error = "adapter_error";
            }
            return { output, trace };
        },
    };
}
//# sourceMappingURL=explain_from_trace.js.map