"use strict";
/**
 * tes_builder skill
 *
 * Calls embedding service TES endpoint through gateway tool routing and
 * returns a validated 512-dim TES vector with deterministic guards.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTesBuilderSkill = createTesBuilderSkill;
const trace_manager_1 = require("../core/trace_manager");
const RULE_ID = "tes_builder_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "embedding.tes_build";
const TOOL_ENDPOINT = "/tes/build";
const DIM_EXPECTED = 512;
const NORM_LOWER = 0.99;
const NORM_UPPER = 1.01;
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value;
}
function normalizeAnchorTags(tags) {
    if (!Array.isArray(tags)) {
        return [];
    }
    const seen = new Set();
    const normalized = [];
    for (const tag of tags) {
        if (typeof tag !== "string") {
            continue;
        }
        const cleaned = tag.trim();
        if (!cleaned) {
            continue;
        }
        const canonical = cleaned.toLocaleLowerCase();
        if (seen.has(canonical)) {
            continue;
        }
        seen.add(canonical);
        normalized.push(canonical);
    }
    return normalized.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}
function resolveRequestTs(value, context) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return Math.trunc(parsed);
        }
    }
    return context.request_ts;
}
function createZeroVector() {
    return Array.from({ length: DIM_EXPECTED }, () => 0);
}
function computeNorm(vector) {
    if (!Array.isArray(vector) || vector.length === 0) {
        return null;
    }
    let sum = 0;
    for (const v of vector) {
        if (!Number.isFinite(v)) {
            return null;
        }
        sum += v * v;
    }
    return Math.sqrt(sum);
}
function buildTrace(requestTs, usedTags, anchorTagCount, normalizedTagCount, visionFeaturesCount, tagSource, latencyMs, vectorChecks, fallbackUsed, fallbackReason, errorMessage, backend, tesVersion, modelId, device) {
    const trace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        request_ts: requestTs,
        input_summary: {
            anchor_tag_count: anchorTagCount,
            normalized_tag_count: normalizedTagCount,
            vision_features_count: visionFeaturesCount,
            first_5_tags: usedTags.slice(0, 5),
        },
        tag_source: tagSource,
        tool: {
            name: TOOL_NAME,
            endpoint: TOOL_ENDPOINT,
        },
        backend,
        tes_version: tesVersion,
        latency_ms: latencyMs,
        vector_checks: vectorChecks,
        fallback_used: fallbackUsed,
    };
    if (fallbackReason !== undefined) {
        trace.fallback_reason = fallbackReason;
    }
    if (modelId !== undefined) {
        trace.model_id = modelId;
    }
    if (device !== undefined) {
        trace.device = device;
    }
    if (errorMessage) {
        trace.error_message = errorMessage;
    }
    return trace;
}
function buildFallbackOutput(reason, requestTs, inputTags, anchorTagCount, normalizedTagCount, visionFeaturesCount, tagSource, latencyMs, errorMessage, upstreamDecisionTrace) {
    const zero = createZeroVector();
    const traceNode = buildTrace(requestTs, inputTags, anchorTagCount, normalizedTagCount, visionFeaturesCount, tagSource, latencyMs, {
        dim_expected: DIM_EXPECTED,
        dim_actual: DIM_EXPECTED,
        finite: true,
        norm: 0,
    }, true, reason, errorMessage, "unknown", "unknown", null, "unknown");
    const mergedDecisionTrace = (0, trace_manager_1.deepMergeTrace)(upstreamDecisionTrace ?? {}, { tes_builder: traceNode });
    const output = {
        tes_vector: zero,
        tes_dim: DIM_EXPECTED,
        normalized: false,
        backend: "unknown",
        tes_version: "unknown",
        input_anchor_tags: inputTags,
        used_anchor_tags: inputTags,
        fallback_used: true,
        fallback_reason: reason,
        decision_trace: mergedDecisionTrace,
    };
    return { output, trace: traceNode };
}
function createTesBuilderSkill(toolClient) {
    return {
        name: "tes_builder",
        inputSchema: {
            description: "Build TES vector from memory_signal anchor tags and optional vision features",
            required: [],
            optional: ["anchor_tags", "normalized_tags", "vision_features", "request_ts", "user_city", "decision_trace"],
        },
        outputSchema: {
            description: "Validated TES vector and trace",
            required: [
                "tes_vector",
                "tes_dim",
                "normalized",
                "backend",
                "tes_version",
                "input_anchor_tags",
                "used_anchor_tags",
                "fallback_used",
                "decision_trace",
            ],
            optional: ["fallback_reason"],
        },
        async execute(input, context) {
            const anchorTags = normalizeAnchorTags(input.anchor_tags);
            const normalizedTags = normalizeAnchorTags(input.normalized_tags);
            const visionFeatures = normalizeAnchorTags(input.vision_features);
            const tagsForTes = anchorTags.length > 0 ? anchorTags : normalizedTags;
            const tagSource = anchorTags.length > 0
                ? "anchor_tags"
                : (normalizedTags.length > 0 ? "normalized_tags_fallback" : "none");
            const requestTs = resolveRequestTs(input.request_ts, context);
            const upstreamDecisionTrace = asObject(input.decision_trace) ?? {};
            if (tagsForTes.length === 0 && visionFeatures.length === 0) {
                return buildFallbackOutput("no_tags", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, 0, tagSource, 0, "", upstreamDecisionTrace);
            }
            const startedAt = Date.now();
            let observation;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: {
                        vision_features: visionFeatures,
                        tags: tagsForTes,
                        normalize: true,
                    },
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallbackOutput("tool_error", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, Date.now() - startedAt, message, upstreamDecisionTrace);
            }
            try {
                if (!observation.ok) {
                    return buildFallbackOutput("tool_error", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), observation.error?.message ?? "gateway_call_failed", upstreamDecisionTrace);
                }
                const payload = asObject(observation.output);
                if (!payload) {
                    return buildFallbackOutput("invalid_output", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), "response_not_object", upstreamDecisionTrace);
                }
                const vectorRaw = payload.vector;
                const dimRaw = Number(payload.dim);
                const normalizedRaw = payload.normalized;
                const meta = asObject(payload.meta);
                const backend = typeof meta?.backend === "string" ? meta.backend : "unknown";
                const tesVersion = typeof meta?.tes_version === "string" ? meta.tes_version : "unknown";
                const modelId = typeof meta?.model_id === "string" || meta?.model_id === null
                    ? meta.model_id
                    : null;
                const device = typeof meta?.device === "string" ? meta.device : "unknown";
                if (!Array.isArray(vectorRaw) || !Number.isFinite(dimRaw) || typeof normalizedRaw !== "boolean") {
                    return buildFallbackOutput("invalid_output", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), "missing_or_invalid_vector_fields", upstreamDecisionTrace);
                }
                const vector = vectorRaw;
                const dimActual = vector.length;
                const finite = vector.every((v) => typeof v === "number" && Number.isFinite(v));
                if (!finite) {
                    return buildFallbackOutput("invalid_vector", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), "vector_contains_non_finite", upstreamDecisionTrace);
                }
                const numericVector = vector;
                const norm = computeNorm(numericVector);
                const invalidVector = dimRaw !== DIM_EXPECTED ||
                    dimActual !== DIM_EXPECTED ||
                    !normalizedRaw ||
                    norm === null ||
                    norm < NORM_LOWER ||
                    norm > NORM_UPPER;
                if (invalidVector) {
                    return buildFallbackOutput("invalid_vector", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), "vector_validation_failed", upstreamDecisionTrace);
                }
                const traceNode = buildTrace(requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), {
                    dim_expected: DIM_EXPECTED,
                    dim_actual: dimActual,
                    finite,
                    norm,
                }, false, undefined, "", backend, tesVersion, modelId, device);
                const mergedDecisionTrace = (0, trace_manager_1.deepMergeTrace)(upstreamDecisionTrace, { tes_builder: traceNode });
                const output = {
                    tes_vector: numericVector,
                    tes_dim: DIM_EXPECTED,
                    normalized: true,
                    backend,
                    tes_version: tesVersion,
                    input_anchor_tags: tagsForTes,
                    used_anchor_tags: tagsForTes,
                    fallback_used: false,
                    decision_trace: mergedDecisionTrace,
                };
                return { output, trace: traceNode };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallbackOutput("invalid_output", requestTs, tagsForTes, anchorTags.length, normalizedTags.length, visionFeatures.length, tagSource, observation.latency_ms ?? (Date.now() - startedAt), message, upstreamDecisionTrace);
            }
        },
    };
}
//# sourceMappingURL=tes_builder.js.map