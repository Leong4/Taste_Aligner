"use strict";
/**
 * tes_builder skill
 *
 * Calls embedding service TES endpoint through gateway tool routing and
 * returns a validated 512-dim TES vector with deterministic guards.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTesBuilderSkill = createTesBuilderSkill;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const url_1 = require("url");
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
function resolveMemoryWriteTimestamp(context) {
    const input = context.input;
    if (typeof input.timestamp === "string" && input.timestamp.trim().length > 0) {
        return { timestamp: input.timestamp.trim(), source: "input_timestamp" };
    }
    if (typeof context.request_ts === "number" && Number.isFinite(context.request_ts)) {
        return {
            timestamp: new Date(Math.trunc(context.request_ts)).toISOString(),
            source: "context_request_ts",
        };
    }
    return { timestamp: "1970-01-01T00:00:00Z", source: "fixed_epoch" };
}
function createZeroVector() {
    return Array.from({ length: DIM_EXPECTED }, () => 0);
}
function resolveVisionSentiment(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return { value: 0.5, source: "neutral_default" };
    }
    return {
        value: Number(Math.max(0, Math.min(1, value)).toFixed(4)),
        source: "vision",
    };
}
function extractCaptionText(input, context) {
    if (typeof input.caption_text === "string" && input.caption_text.trim()) {
        return input.caption_text.trim();
    }
    if (typeof context.input.caption === "string" && context.input.caption.trim()) {
        return context.input.caption.trim();
    }
    if (typeof context.input.text === "string" && context.input.text.trim()) {
        return context.input.text.trim();
    }
    return "";
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
function hasUploadImageSignal(context) {
    const root = context;
    const input = context.input;
    return !!(root.image ||
        input?.image ||
        (typeof input?.image_url === "string" && input.image_url.trim()) ||
        (typeof input?.image_original_base64 === "string" && input.image_original_base64.trim()) ||
        (typeof input?.image_base64 === "string" && input.image_base64.trim()));
}
function normalizeDataUrl(value, defaultMime) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) {
        return trimmed;
    }
    // Accept raw base64 payloads from test or non-UI callers.
    return `data:${defaultMime};base64,${trimmed}`;
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
        // Always present: deterministic evidence of keys forwarded to embedding.tes_build.
        // Kept in buildTrace (not just success path) so fallback traces also include it.
        tes_build_payload_keys: ["normalize", "tags", "vision_features"],
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
// ---------------------------------------------------------------------------
// Memory write side effect — fire-and-resolve, never throws
// ---------------------------------------------------------------------------
/**
 * POST a memory record to the memory service (upload flow only).
 * Reads MEMORY_SERVICE_URL at call time so tests can override it.
 * Returns "ok" on 2xx, "failed" on any error or non-2xx.
 */
async function writeMemoryRecord(body) {
    const baseUrl = (process.env.MEMORY_SERVICE_URL ?? "http://localhost:5001").replace(/\/$/, "");
    const url = new url_1.URL(`${baseUrl}/write`);
    const payload = JSON.stringify({ data: body });
    const mod = url.protocol === "https:" ? https_1.default : http_1.default;
    return new Promise((resolve) => {
        try {
            const req = mod.request({
                hostname: url.hostname,
                port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                },
                timeout: 2000,
            }, (res) => {
                res.resume(); // drain response body
                if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
                    resolve("ok");
                }
                else {
                    console.warn(`[tes_builder] memory.write HTTP ${res.statusCode}`);
                    resolve("failed");
                }
            });
            req.on("timeout", () => {
                req.destroy();
                console.warn("[tes_builder] memory.write timed out");
                resolve("failed");
            });
            req.on("error", (err) => {
                console.warn(`[tes_builder] memory.write error: ${err.message}`);
                resolve("failed");
            });
            req.write(payload);
            req.end();
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[tes_builder] memory.write exception: ${msg}`);
            resolve("failed");
        }
    });
}
// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------
function createTesBuilderSkill(toolClient) {
    return {
        name: "tes_builder",
        inputSchema: {
            description: "Build TES vector from memory_signal anchor tags and optional vision features",
            required: [],
            optional: ["anchor_tags", "normalized_tags", "vision_features", "vision_tags", "request_ts", "user_city", "decision_trace"],
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
            const visionTags = normalizeAnchorTags(input.vision_tags);
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
                // Upload flow: persist embedding to memory service as a side effect.
                // Triggered only when the original request carried an image (explicit signal).
                // Never throws; result only affects trace, not recommendation output.
                const isUploadFlow = hasUploadImageSignal(context);
                traceNode.memory_persisted = isUploadFlow;
                if (isUploadFlow) {
                    const writeTimestamp = resolveMemoryWriteTimestamp(context);
                    const captionText = extractCaptionText(input, context);
                    const sentiment = resolveVisionSentiment(input.sentiment);
                    const visionSemanticTags = visionTags.length > 0 ? visionTags : visionFeatures;
                    const writeTags = visionTags.length > 0
                        ? visionTags
                        : (tagsForTes.length > 0 ? tagsForTes : visionSemanticTags);
                    const writeNormalizedTags = visionTags.length > 0
                        ? visionTags
                        : (normalizedTags.length > 0 ? normalizedTags : writeTags);
                    const writeBody = {
                        user_id: context.input.user_id ?? "demo_user",
                        timestamp: writeTimestamp.timestamp,
                        raw_tags: writeTags,
                        normalized_tags: writeNormalizedTags,
                        embedding: numericVector,
                        source: "upload",
                        sentiment: sentiment.value,
                    };
                    if (captionText) {
                        writeBody.caption_text = captionText;
                    }
                    if (typeof input.vision_type === "string" && input.vision_type.length > 0) {
                        writeBody.vision_type = input.vision_type;
                    }
                    const originalImageBase64 = normalizeDataUrl(context.input.image_original_base64 ?? context.input.image_base64, "image/jpeg");
                    if (originalImageBase64) {
                        writeBody.image_base64 = originalImageBase64;
                    }
                    const visionInputBase64 = normalizeDataUrl(context.input.image_base64, "image/webp");
                    if (visionInputBase64 && visionInputBase64 !== originalImageBase64) {
                        writeBody.image_vision_input_base64 = visionInputBase64;
                    }
                    if (typeof context.input.image_url === "string" && context.input.image_url.trim()) {
                        writeBody.image_url = context.input.image_url;
                    }
                    if (typeof input.user_city === "string" && input.user_city.length > 0) {
                        writeBody.city = input.user_city;
                    }
                    else if (typeof context.input.city === "string" && context.input.city.trim().length > 0) {
                        writeBody.city = context.input.city.trim();
                    }
                    // Fire-and-forget: do not block the pipeline.
                    // Status is set to "queued" deterministically; actual result is discarded.
                    traceNode.timestamp_source = writeTimestamp.source;
                    traceNode.sentiment_source = sentiment.source;
                    traceNode.sentiment_value = sentiment.value;
                    traceNode.memory_write_status = "queued";
                    writeMemoryRecord(writeBody).catch(() => void 0);
                }
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