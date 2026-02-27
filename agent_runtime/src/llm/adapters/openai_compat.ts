/**
 * OpenAICompatAdapter — production LLM adapter for OpenAI-compatible endpoints.
 *
 * Compatible with:
 *   - OpenAI API (https://api.openai.com/v1)
 *   - Qwen and other OpenAI-compatible endpoints
 *
 * Design decisions:
 *   - Uses Node's built-in http/https modules (no fetch, no extra deps)
 *   - latency_ms is set to 0 in callTrace for deterministic decision_trace
 *   - Retries up to LLM_MAX_RETRIES times (default: 2) on network/server errors
 *   - Throws on unrecoverable error so the skill's catch block handles fallback
 */

import http from "http";
import https from "https";
import { URL } from "url";
import {
    LLMAdapter,
    LLMCallTrace,
    LLMGenerateInput,
    LLMGenerateOutput,
    LLMModelInfo,
    LLMUsage,
} from "../llm_adapter";

// ---------------------------------------------------------------------------
// HTTP helper — plain http/https POST returning parsed JSON
// ---------------------------------------------------------------------------

function postJson(
    url: string,
    apiKey: string,
    body: unknown
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const isHttps = parsed.protocol === "https:";
        const transport = isHttps ? https : http;

        const bodyStr = JSON.stringify(body);
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port
                ? parseInt(parsed.port, 10)
                : isHttps ? 443 : 80,
            path: parsed.pathname + parsed.search,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
                "Content-Length": Buffer.byteLength(bodyStr),
            },
        };

        const req = transport.request(options, (res) => {
            let data = "";
            res.on("data", (chunk: Buffer | string) => { data += chunk; });
            res.on("end", () => {
                const status = res.statusCode ?? 0;
                if (status >= 400) {
                    reject(new Error(
                        `OpenAICompat HTTP ${status}: ${data.slice(0, 300)}`
                    ));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new Error(
                        `OpenAICompat: failed to parse response JSON: ${data.slice(0, 200)}`
                    ));
                }
            });
        });

        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpenAICompatOptions {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    maxRetries?: number;
}

const ZERO_USAGE: LLMUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
};

export class OpenAICompatAdapter implements LLMAdapter {
    readonly modelInfo: LLMModelInfo;
    // fallbackReason intentionally absent — this is the real provider, not a fallback.

    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly maxRetries: number;

    constructor(options: OpenAICompatOptions) {
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const modelName =
            options.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
        this.maxRetries =
            options.maxRetries ??
            parseInt(process.env.LLM_MAX_RETRIES ?? "2", 10);
        this.modelInfo = {
            provider: "openai_compat",
            model_name: modelName,
            version: "1.0.0",
        };
    }

    async generateStructuredJSON<T>(
        input: LLMGenerateInput
    ): Promise<LLMGenerateOutput<T>> {
        const url = `${this.baseUrl}/chat/completions`;
        const requestBody = {
            model: this.modelInfo.model_name,
            messages: [
                { role: "system", content: input.systemPrompt },
                { role: "user", content: input.userPrompt },
            ],
            temperature: input.temperature,
            response_format: { type: "json_object" },
        };

        let lastError: Error = new Error("OpenAICompatAdapter: no attempts made");

        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await postJson(
                    url,
                    this.apiKey,
                    requestBody
                ) as Record<string, unknown>;

                // Parse choices[0].message.content
                const choices = response.choices as
                    | Array<{ message: { content: string } }>
                    | undefined;
                if (!choices?.[0]?.message?.content) {
                    throw new Error(
                        "OpenAICompat: invalid response shape — missing choices[0].message.content"
                    );
                }

                const content = choices[0].message.content;
                let data: T;
                try {
                    data = JSON.parse(content) as T;
                } catch {
                    throw new Error(
                        `OpenAICompat: failed to parse model JSON: ${content.slice(0, 200)}`
                    );
                }

                const rawUsage = response.usage as
                    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
                    | undefined;
                const usage: LLMUsage = {
                    prompt_tokens: rawUsage?.prompt_tokens ?? 0,
                    completion_tokens: rawUsage?.completion_tokens ?? 0,
                    total_tokens: rawUsage?.total_tokens ?? 0,
                };

                const callTrace: LLMCallTrace = {
                    model: this.modelInfo,
                    temperature: input.temperature,
                    prompt_version: input.promptVersion,
                    latency_ms: 0, // intentionally 0 — latency not recorded in traces
                    usage,
                    fallback_used: false,
                };

                return { data, usage, callTrace };
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
            }
        }

        throw lastError;
    }
}
