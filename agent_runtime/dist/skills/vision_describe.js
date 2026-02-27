"use strict";
/**
 * vision_describe skill
 *
 * Calls the vision service via the gateway tool "vision.describe" and returns
 * a deterministic, normalised list of vision_features (tags) for downstream
 * TES enrichment.
 *
 * Determinism contract:
 *   - Tags are lowercased, trimmed, deduped, then sorted with
 *     localeCompare({ numeric: true, sensitivity: "base" }).
 *   - Up to MAX_TAGS tags are returned.
 *   - When no image is provided (no image_url AND no image_base64) the skill
 *     returns an empty vision_features list WITHOUT calling the gateway.
 *     fallback_reason is set to "no_image".
 *   - Any gateway / output error results in an empty list with
 *     fallback_used=true and an appropriate fallback_reason.
 *   - The skill never throws — all errors produce a fallback result.
 *
 * Decision trace written to decision_trace.vision_describe:
 *   used, backend, model_id, device, tags_count, latency_ms,
 *   fallback_used, fallback_reason, input_summary
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVisionDescribeSkill = createVisionDescribeSkill;
const RULE_ID = "vision_describe_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "vision.describe";
const MAX_TAGS = 50;
const DEFAULT_TOP_K = 10;
function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    return value;
}
/** Lowercase, trim, dedupe, sort — deterministic for any tag list order. */
function normalizeTags(raw) {
    if (!Array.isArray(raw))
        return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        if (typeof item !== "string")
            continue;
        const cleaned = item.trim().toLowerCase();
        if (!cleaned || seen.has(cleaned))
            continue;
        seen.add(cleaned);
        out.push(cleaned);
    }
    return out
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
        .slice(0, MAX_TAGS);
}
function clampTopK(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(1, Math.min(Math.trunc(value), MAX_TAGS));
    }
    return DEFAULT_TOP_K;
}
function buildTrace(used, backend, modelId, device, tagsCount, latencyMs, fallbackUsed, fallbackReason, inputSummary) {
    const trace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        used,
        tags_count: tagsCount,
        fallback_used: fallbackUsed,
        input_summary: inputSummary,
    };
    if (backend !== undefined)
        trace.backend = backend;
    if (modelId !== undefined)
        trace.model_id = modelId;
    if (device !== undefined)
        trace.device = device;
    if (latencyMs !== undefined)
        trace.latency_ms = latencyMs;
    if (fallbackReason !== undefined)
        trace.fallback_reason = fallbackReason;
    return trace;
}
function buildFallback(fallbackReason, latencyMs, inputSummary) {
    const trace = buildTrace(false, undefined, undefined, undefined, 0, latencyMs, true, fallbackReason, inputSummary);
    const output = {
        vision_features: [],
        used: false,
        tags_count: 0,
        fallback_used: true,
        fallback_reason: fallbackReason,
        decision_trace: { vision_describe: trace },
    };
    if (latencyMs !== undefined) {
        output.latency_ms = latencyMs;
    }
    return {
        output,
        trace,
    };
}
function createVisionDescribeSkill(toolClient) {
    return {
        name: "vision_describe",
        inputSchema: {
            description: "Describe an image and extract tags using vision backend",
            required: [],
            optional: ["image_url", "image_base64", "top_k"],
        },
        outputSchema: {
            description: "Extracted vision tags for multimodal TES input",
            required: ["vision_features", "used", "fallback_used", "tags_count", "decision_trace"],
            optional: ["backend", "model_id", "device", "latency_ms", "fallback_reason"],
        },
        async execute(input, _context) {
            const hasUrl = typeof input.image_url === "string" && input.image_url.trim().length > 0;
            const hasBase64 = typeof input.image_base64 === "string" && input.image_base64.trim().length > 0;
            const topK = clampTopK(input.top_k);
            const inputSummary = { has_url: hasUrl, has_base64: hasBase64, top_k: topK };
            // ── No image: deterministic fallback without calling gateway ─────
            if (!hasUrl && !hasBase64) {
                return buildFallback("no_image", undefined, inputSummary);
            }
            // ── Call gateway ─────────────────────────────────────────────────
            const startedAt = Date.now();
            let observation;
            try {
                const toolInput = { top_k: topK };
                if (hasUrl)
                    toolInput.image_url = input.image_url;
                if (hasBase64)
                    toolInput.image_base64 = input.image_base64;
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: { data: toolInput },
                });
            }
            catch (_err) {
                return buildFallback("tool_error", Date.now() - startedAt, inputSummary);
            }
            const latencyMs = observation.latency_ms ?? (Date.now() - startedAt);
            if (!observation.ok) {
                return buildFallback("tool_error", latencyMs, inputSummary);
            }
            const payload = asObject(observation.output);
            if (!payload || !Array.isArray(payload.tags)) {
                return buildFallback("invalid_output", latencyMs, inputSummary);
            }
            // ── Normalise output ─────────────────────────────────────────────
            const normalizedTags = normalizeTags(payload.tags);
            const backend = typeof payload.backend === "string" ? payload.backend : undefined;
            const modelId = typeof payload.model_id === "string" || payload.model_id === null
                ? payload.model_id
                : undefined;
            const device = typeof payload.device === "string" ? payload.device : undefined;
            const trace = buildTrace(true, backend, modelId, device, normalizedTags.length, latencyMs, false, undefined, inputSummary);
            const output = {
                vision_features: normalizedTags,
                used: true,
                tags_count: normalizedTags.length,
                latency_ms: latencyMs,
                fallback_used: false,
                decision_trace: { vision_describe: trace },
            };
            if (backend !== undefined)
                output.backend = backend;
            if (modelId !== undefined)
                output.model_id = modelId;
            if (device !== undefined)
                output.device = device;
            return {
                output,
                trace,
            };
        },
    };
}
//# sourceMappingURL=vision_describe.js.map