/**
 * tes_builder skill
 *
 * Calls embedding service TES endpoint through gateway tool routing and
 * returns a validated 512-dim TES vector with deterministic guards.
 */

import {
    Skill,
    SkillResult,
    ExecutionContext,
    TesBuilderInput,
    TesBuilderOutput,
    TesBuilderDecisionTrace,
} from "../core/types";
import { ToolClient } from "../tools/toolClient";
import { deepMergeTrace } from "../core/trace_manager";

const RULE_ID = "tes_builder_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "embedding.tes_build";
const TOOL_ENDPOINT = "/tes/build";
const DIM_EXPECTED = 512;
const NORM_LOWER = 0.99;
const NORM_UPPER = 1.01;

type FallbackReason = "no_tags" | "tool_error" | "invalid_output" | "invalid_vector";

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function normalizeAnchorTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) {
        return [];
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
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
    return normalized.sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
}

function resolveRequestTs(value: unknown, context: ExecutionContext): number {
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

function createZeroVector(): number[] {
    return Array.from({ length: DIM_EXPECTED }, () => 0);
}

function computeNorm(vector: number[]): number | null {
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

function buildTrace(
    requestTs: number,
    inputTags: string[],
    latencyMs: number,
    vectorChecks: TesBuilderDecisionTrace["vector_checks"],
    fallbackUsed: boolean,
    fallbackReason: FallbackReason | undefined,
    errorMessage: string,
    backend: string,
    tesVersion: string
): TesBuilderDecisionTrace {
    const trace: TesBuilderDecisionTrace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        request_ts: requestTs,
        input_summary: {
            anchor_tag_count: inputTags.length,
            first_5_tags: inputTags.slice(0, 5),
        },
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
    if (errorMessage) {
        trace.error_message = errorMessage;
    }
    return trace;
}

function buildFallbackOutput(
    reason: FallbackReason,
    requestTs: number,
    inputTags: string[],
    latencyMs: number,
    errorMessage: string,
    upstreamDecisionTrace?: Record<string, unknown>
): SkillResult<TesBuilderOutput> {
    const zero = createZeroVector();
    const traceNode = buildTrace(
        requestTs,
        inputTags,
        latencyMs,
        {
            dim_expected: DIM_EXPECTED,
            dim_actual: DIM_EXPECTED,
            finite: true,
            norm: 0,
        },
        true,
        reason,
        errorMessage,
        "unknown",
        "unknown"
    );

    const mergedDecisionTrace = deepMergeTrace(
        upstreamDecisionTrace ?? {},
        { tes_builder: traceNode }
    );

    const output: TesBuilderOutput = {
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

export function createTesBuilderSkill(
    toolClient: ToolClient
): Skill<TesBuilderInput, TesBuilderOutput> {
    return {
        name: "tes_builder",

        inputSchema: {
            description: "Build TES vector from memory_signal anchor tags",
            required: ["anchor_tags"],
            optional: ["request_ts", "user_city", "decision_trace"],
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

        async execute(
            input: TesBuilderInput,
            context: ExecutionContext
        ): Promise<SkillResult<TesBuilderOutput>> {
            const anchorTags = normalizeAnchorTags(input.anchor_tags);
            const requestTs = resolveRequestTs(input.request_ts, context);
            const upstreamDecisionTrace = asObject(input.decision_trace) ?? {};

            if (anchorTags.length === 0) {
                return buildFallbackOutput(
                    "no_tags",
                    requestTs,
                    anchorTags,
                    0,
                    "",
                    upstreamDecisionTrace
                );
            }

            const startedAt = Date.now();
            let observation: Awaited<ReturnType<ToolClient["call"]>>;
            try {
                observation = await toolClient.call({
                    tool: TOOL_NAME,
                    input: {
                        data: {
                            vision_tags: [],
                            normalized_tags: anchorTags,
                            emotion: null,
                            recency_days: null,
                        },
                    },
                });
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallbackOutput(
                    "tool_error",
                    requestTs,
                    anchorTags,
                    Date.now() - startedAt,
                    message,
                    upstreamDecisionTrace
                );
            }

            try {
                if (!observation.ok) {
                    return buildFallbackOutput(
                        "tool_error",
                        requestTs,
                        anchorTags,
                        observation.latency_ms ?? (Date.now() - startedAt),
                        observation.error?.message ?? "gateway_call_failed",
                        upstreamDecisionTrace
                    );
                }

                const payload = asObject(observation.output);
                if (!payload) {
                    return buildFallbackOutput(
                        "invalid_output",
                        requestTs,
                        anchorTags,
                        observation.latency_ms ?? (Date.now() - startedAt),
                        "response_not_object",
                        upstreamDecisionTrace
                    );
                }

                const vectorRaw = payload.vector;
                const dimRaw = Number(payload.dim);
                const normalizedRaw = payload.normalized;
                const meta = asObject(payload.meta);
                const backend = typeof meta?.backend === "string" ? meta.backend : "unknown";
                const tesVersion = typeof meta?.tes_version === "string" ? meta.tes_version : "unknown";

                if (!Array.isArray(vectorRaw) || !Number.isFinite(dimRaw) || typeof normalizedRaw !== "boolean") {
                    return buildFallbackOutput(
                        "invalid_output",
                        requestTs,
                        anchorTags,
                        observation.latency_ms ?? (Date.now() - startedAt),
                        "missing_or_invalid_vector_fields",
                        upstreamDecisionTrace
                    );
                }

                const vector = vectorRaw as unknown[];
                const dimActual = vector.length;
                const finite = vector.every((v) => typeof v === "number" && Number.isFinite(v));
                if (!finite) {
                    return buildFallbackOutput(
                        "invalid_vector",
                        requestTs,
                        anchorTags,
                        observation.latency_ms ?? (Date.now() - startedAt),
                        "vector_contains_non_finite",
                        upstreamDecisionTrace
                    );
                }
                const numericVector = vector as number[];
                const norm = computeNorm(numericVector);

                const invalidVector =
                    dimRaw !== DIM_EXPECTED ||
                    dimActual !== DIM_EXPECTED ||
                    !normalizedRaw ||
                    norm === null ||
                    norm < NORM_LOWER ||
                    norm > NORM_UPPER;

                if (invalidVector) {
                    return buildFallbackOutput(
                        "invalid_vector",
                        requestTs,
                        anchorTags,
                        observation.latency_ms ?? (Date.now() - startedAt),
                        "vector_validation_failed",
                        upstreamDecisionTrace
                    );
                }

                const traceNode = buildTrace(
                    requestTs,
                    anchorTags,
                    observation.latency_ms ?? (Date.now() - startedAt),
                    {
                        dim_expected: DIM_EXPECTED,
                        dim_actual: dimActual,
                        finite,
                        norm,
                    },
                    false,
                    undefined,
                    "",
                    backend,
                    tesVersion
                );

                const mergedDecisionTrace = deepMergeTrace(
                    upstreamDecisionTrace,
                    { tes_builder: traceNode }
                );

                const output: TesBuilderOutput = {
                    tes_vector: numericVector,
                    tes_dim: DIM_EXPECTED,
                    normalized: true,
                    backend,
                    tes_version: tesVersion,
                    input_anchor_tags: anchorTags,
                    used_anchor_tags: anchorTags,
                    fallback_used: false,
                    decision_trace: mergedDecisionTrace,
                };

                return { output, trace: traceNode };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                return buildFallbackOutput(
                    "invalid_output",
                    requestTs,
                    anchorTags,
                    observation.latency_ms ?? (Date.now() - startedAt),
                    message,
                    upstreamDecisionTrace
                );
            }
        },
    };
}
