/**
 * persist_memory skill
 *
 * Upload persistence is a confirmed graph step, not a fire-and-forget side
 * effect. The skill waits for Memory Service acknowledgement, retries bounded
 * transient failures with the same memory_id, and reports honest status.
 */

import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
    ExecutionContext,
    PersistMemoryDecisionTrace,
    PersistMemoryInput,
    PersistMemoryOutput,
    Skill,
    SkillResult,
} from "../core/types";

const RULE_ID = "persist_memory_v1";
const SCHEMA_VERSION = "1.0";
const TES_DIM = 512;
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 100;

interface WriteAttemptResult {
    ok: boolean;
    retryable: boolean;
    httpStatus?: number;
    memoryId?: string;
    idempotentReplay?: boolean;
    errorCode?: string;
    errorMessage?: string;
}

function clamp01(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function clampSigned(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Number(Math.max(-1, Math.min(1, value)).toFixed(4));
}

function normalizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
        value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b));
}

function normalizeDataUrl(value: unknown, defaultMime: "image/jpeg" | "image/webp"): string {
    if (typeof value !== "string" || !value.trim()) return "";
    const trimmed = value.trim();
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(trimmed)) return trimmed;
    return `data:${defaultMime};base64,${trimmed}`;
}

function isUpload(input: PersistMemoryInput): boolean {
    return [input.image_url, input.image_base64, input.image_original_base64]
        .some((value) => typeof value === "string" && value.trim().length > 0);
}

function isValidTes(input: PersistMemoryInput): input is PersistMemoryInput & { tes_vector: number[] } {
    if (input.tes_fallback_used === true || input.tes_normalized !== true || input.tes_dim !== TES_DIM) {
        return false;
    }
    if (!Array.isArray(input.tes_vector) || input.tes_vector.length !== TES_DIM) return false;
    let sum = 0;
    for (const value of input.tes_vector) {
        if (typeof value !== "number" || !Number.isFinite(value)) return false;
        sum += value * value;
    }
    const norm = Math.sqrt(sum);
    return norm >= 0.99 && norm <= 1.01;
}

function resolveTimestamp(input: PersistMemoryInput, context: ExecutionContext): string {
    if (typeof input.request_ts === "string" && input.request_ts.trim()) {
        const numeric = Number(input.request_ts);
        if (!Number.isFinite(numeric)) return input.request_ts.trim();
        return new Date(Math.trunc(numeric)).toISOString();
    }
    if (typeof input.request_ts === "number" && Number.isFinite(input.request_ts)) {
        return new Date(Math.trunc(input.request_ts)).toISOString();
    }
    return new Date(Math.trunc(context.request_ts)).toISOString();
}

function positiveInt(value: string | undefined, fallback: number, maximum: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(maximum, Math.trunc(parsed));
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postMemory(body: Record<string, unknown>, timeoutMs: number): Promise<WriteAttemptResult> {
    const baseUrl = (process.env.MEMORY_SERVICE_URL ?? "http://localhost:5001").replace(/\/$/, "");
    const url = new URL(`${baseUrl}/write`);
    const payload = JSON.stringify({ data: body });
    const transport = url.protocol === "https:" ? https : http;

    return new Promise((resolve) => {
        let settled = false;
        const finish = (result: WriteAttemptResult) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        try {
            const request = transport.request(
                {
                    hostname: url.hostname,
                    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
                    path: `${url.pathname}${url.search}`,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(payload),
                    },
                    timeout: timeoutMs,
                },
                (response) => {
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    response.on("data", (chunk: Buffer | string) => {
                        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                        bytes += buffer.length;
                        if (bytes <= 1024 * 1024) chunks.push(buffer);
                    });
                    response.on("end", () => {
                        const status = response.statusCode ?? 0;
                        const text = Buffer.concat(chunks).toString("utf8");
                        let parsed: Record<string, unknown> | null = null;
                        try {
                            const candidate: unknown = text ? JSON.parse(text) : null;
                            if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
                                parsed = candidate as Record<string, unknown>;
                            }
                        } catch {
                            parsed = null;
                        }
                        if (status >= 200 && status < 300) {
                            const memoryId = typeof parsed?.memory_id === "string" ? parsed.memory_id : "";
                            if (!memoryId) {
                                finish({
                                    ok: false,
                                    retryable: false,
                                    httpStatus: status,
                                    errorCode: "invalid_response",
                                    errorMessage: "Memory Service returned 2xx without memory_id",
                                });
                                return;
                            }
                            finish({
                                ok: true,
                                retryable: false,
                                httpStatus: status,
                                memoryId,
                                idempotentReplay: parsed?.idempotent_replay === true,
                            });
                            return;
                        }
                        const retryable = status === 408 || status === 429 || status >= 500;
                        finish({
                            ok: false,
                            retryable,
                            httpStatus: status,
                            errorCode: `http_${status || "unknown"}`,
                            errorMessage: text.slice(0, 300) || `Memory Service HTTP ${status}`,
                        });
                    });
                },
            );
            request.on("timeout", () => {
                request.destroy();
                finish({
                    ok: false,
                    retryable: true,
                    errorCode: "timeout",
                    errorMessage: `Memory write exceeded ${timeoutMs}ms`,
                });
            });
            request.on("error", (error: Error) => {
                finish({
                    ok: false,
                    retryable: true,
                    errorCode: "network_error",
                    errorMessage: error.message,
                });
            });
            request.write(payload);
            request.end();
        } catch (error: unknown) {
            finish({
                ok: false,
                retryable: false,
                errorCode: "request_error",
                errorMessage: error instanceof Error ? error.message : String(error),
            });
        }
    });
}

function resultWithTrace(trace: PersistMemoryDecisionTrace): SkillResult<PersistMemoryOutput> {
    const output: PersistMemoryOutput = {
        memory_write_status: trace.status,
        memory_persisted: trace.memory_persisted,
        attempts: trace.attempts,
        decision_trace: { persist_memory: trace },
    };
    if (trace.memory_id !== undefined) output.memory_id = trace.memory_id;
    if (trace.http_status !== undefined) output.http_status = trace.http_status;
    if (trace.error_code !== undefined) output.error_code = trace.error_code;
    if (trace.error_message !== undefined) output.error_message = trace.error_message;
    return { output, trace };
}

export function createPersistMemorySkill(): Skill<PersistMemoryInput, PersistMemoryOutput> {
    return {
        name: "persist_memory",
        inputSchema: {
            description: "Synchronously persist an upload memory with bounded idempotent retries",
            required: [],
            optional: [
                "user_id", "memory_id", "city", "caption_text", "request_ts",
                "image_url", "image_base64", "image_original_base64",
                "normalized_tags", "vision_tags", "vision_features", "vision_type",
                "tes_vector", "tes_dim", "tes_normalized", "tes_fallback_used",
                "sentiment", "sentiment_confidence", "sentiment_available", "sentiment_source",
            ],
        },
        outputSchema: {
            description: "Confirmed memory persistence status and service acknowledgement",
            required: ["memory_write_status", "memory_persisted", "attempts", "decision_trace"],
            optional: ["memory_id", "http_status", "error_code", "error_message"],
        },
        async execute(
            input: PersistMemoryInput,
            context: ExecutionContext,
        ): Promise<SkillResult<PersistMemoryOutput>> {
            const startedAt = Date.now();
            const sentiment = clampSigned(input.sentiment);
            const sentimentAvailable = input.sentiment_available === true;
            const sentimentConfidence = sentimentAvailable ? clamp01(input.sentiment_confidence) : 0;
            const sentimentSource = typeof input.sentiment_source === "string" && input.sentiment_source.trim()
                ? input.sentiment_source.trim()
                : "missing_caption";

            if (!isUpload(input)) {
                return resultWithTrace({
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    status: "skipped",
                    memory_persisted: false,
                    attempts: 0,
                    latency_ms: Date.now() - startedAt,
                    sentiment_value: sentiment,
                    sentiment_confidence: sentimentConfidence,
                    sentiment_available: sentimentAvailable,
                    sentiment_source: sentimentSource,
                    fallback_used: true,
                    fallback_reason: "not_upload_flow",
                });
            }

            const requestedMemoryId = typeof input.memory_id === "string" ? input.memory_id.trim() : "";
            if (requestedMemoryId && !/^[A-Za-z0-9._-]{1,128}$/.test(requestedMemoryId)) {
                return resultWithTrace({
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    status: "failed",
                    memory_persisted: false,
                    attempts: 0,
                    latency_ms: Date.now() - startedAt,
                    sentiment_value: sentiment,
                    sentiment_confidence: sentimentConfidence,
                    sentiment_available: sentimentAvailable,
                    sentiment_source: sentimentSource,
                    fallback_used: true,
                    fallback_reason: "write_failed",
                    error_code: "invalid_memory_id",
                    error_message: "memory_id must contain only letters, digits, dot, underscore, or hyphen",
                });
            }
            const memoryId = requestedMemoryId || randomUUID();

            if (!isValidTes(input)) {
                return resultWithTrace({
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    status: "failed",
                    memory_persisted: false,
                    memory_id: memoryId,
                    attempts: 0,
                    latency_ms: Date.now() - startedAt,
                    sentiment_value: sentiment,
                    sentiment_confidence: sentimentConfidence,
                    sentiment_available: sentimentAvailable,
                    sentiment_source: sentimentSource,
                    fallback_used: true,
                    fallback_reason: "invalid_tes",
                    error_code: "invalid_tes",
                    error_message: "A valid normalized 512-dimensional TES vector is required",
                });
            }

            const visionTags = normalizeTags(input.vision_tags);
            const visionFeatures = normalizeTags(input.vision_features);
            const normalizedTags = normalizeTags(input.normalized_tags);
            const rawTags = visionTags.length > 0
                ? visionTags
                : (visionFeatures.length > 0 ? visionFeatures : normalizedTags);
            const body: Record<string, unknown> = {
                memory_id: memoryId,
                user_id: typeof input.user_id === "string" && input.user_id.trim()
                    ? input.user_id.trim()
                    : "demo_user",
                timestamp: resolveTimestamp(input, context),
                raw_tags: rawTags,
                normalized_tags: normalizedTags.length > 0 ? normalizedTags : rawTags,
                embedding: input.tes_vector,
                source: "upload",
                sentiment,
                sentiment_scale: "signed_v1",
                sentiment_confidence: sentimentConfidence,
                sentiment_available: sentimentAvailable,
                sentiment_source: sentimentSource,
            };
            if (typeof input.caption_text === "string" && input.caption_text.trim()) {
                body.caption_text = input.caption_text.trim();
            }
            if (typeof input.city === "string" && input.city.trim()) body.city = input.city.trim();
            if (typeof input.vision_type === "string" && input.vision_type.trim()) {
                body.vision_type = input.vision_type.trim();
            }
            const originalImage = normalizeDataUrl(
                input.image_original_base64 ?? input.image_base64,
                "image/jpeg",
            );
            if (originalImage) body.image_base64 = originalImage;
            const visionInput = normalizeDataUrl(input.image_base64, "image/webp");
            if (visionInput && visionInput !== originalImage) {
                body.image_vision_input_base64 = visionInput;
            }
            if (typeof input.image_url === "string" && input.image_url.trim()) {
                body.image_url = input.image_url.trim();
            }

            const timeoutMs = positiveInt(process.env.MEMORY_WRITE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 30000);
            const maxAttempts = positiveInt(
                process.env.MEMORY_WRITE_MAX_ATTEMPTS,
                DEFAULT_MAX_ATTEMPTS,
                5,
            );
            const retryBaseMs = positiveInt(
                process.env.MEMORY_WRITE_RETRY_BASE_MS,
                DEFAULT_RETRY_BASE_MS,
                5000,
            );
            let last: WriteAttemptResult = {
                ok: false,
                retryable: false,
                errorCode: "write_failed",
                errorMessage: "Memory write was not attempted",
            };
            let attempts = 0;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                attempts = attempt;
                last = await postMemory(body, timeoutMs);
                if (last.ok || !last.retryable || attempt === maxAttempts) break;
                await wait(retryBaseMs * attempt);
            }

            if (last.ok) {
                const trace: PersistMemoryDecisionTrace = {
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    status: "persisted",
                    memory_persisted: true,
                    memory_id: last.memoryId ?? memoryId,
                    attempts,
                    latency_ms: Date.now() - startedAt,
                    sentiment_value: sentiment,
                    sentiment_confidence: sentimentConfidence,
                    sentiment_available: sentimentAvailable,
                    sentiment_source: sentimentSource,
                    fallback_used: false,
                };
                if (last.httpStatus !== undefined) trace.http_status = last.httpStatus;
                if (last.idempotentReplay !== undefined) trace.idempotent_replay = last.idempotentReplay;
                return resultWithTrace(trace);
            }

            const trace: PersistMemoryDecisionTrace = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                status: "failed",
                memory_persisted: false,
                memory_id: memoryId,
                attempts,
                latency_ms: Date.now() - startedAt,
                sentiment_value: sentiment,
                sentiment_confidence: sentimentConfidence,
                sentiment_available: sentimentAvailable,
                sentiment_source: sentimentSource,
                fallback_used: true,
                fallback_reason: "write_failed",
                error_code: last.errorCode ?? "write_failed",
                error_message: last.errorMessage ?? "Memory Service rejected the write",
            };
            if (last.httpStatus !== undefined) trace.http_status = last.httpStatus;
            return resultWithTrace(trace);
        },
    };
}
