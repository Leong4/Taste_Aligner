"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAICompatAdapter = void 0;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const url_1 = require("url");
// ---------------------------------------------------------------------------
// HTTP helper — plain http/https POST returning parsed JSON
// ---------------------------------------------------------------------------
function postJson(url, apiKey, body) {
    return new Promise((resolve, reject) => {
        const parsed = new url_1.URL(url);
        const isHttps = parsed.protocol === "https:";
        const transport = isHttps ? https_1.default : http_1.default;
        const bodyStr = JSON.stringify(body);
        const options = {
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
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                const status = res.statusCode ?? 0;
                if (status >= 400) {
                    reject(new Error(`OpenAICompat HTTP ${status}: ${data.slice(0, 300)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                }
                catch {
                    reject(new Error(`OpenAICompat: failed to parse response JSON: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on("error", reject);
        req.write(bodyStr);
        req.end();
    });
}
const ZERO_USAGE = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
};
class OpenAICompatAdapter {
    constructor(options) {
        this.apiKey = options.apiKey;
        this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
        const modelName = options.model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
        this.maxRetries =
            options.maxRetries ??
                parseInt(process.env.LLM_MAX_RETRIES ?? "2", 10);
        this.modelInfo = {
            provider: "openai_compat",
            model_name: modelName,
            version: "1.0.0",
        };
    }
    async generateStructuredJSON(input) {
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
        let lastError = new Error("OpenAICompatAdapter: no attempts made");
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await postJson(url, this.apiKey, requestBody);
                // Parse choices[0].message.content
                const choices = response.choices;
                if (!choices?.[0]?.message?.content) {
                    throw new Error("OpenAICompat: invalid response shape — missing choices[0].message.content");
                }
                const content = choices[0].message.content;
                let data;
                try {
                    data = JSON.parse(content);
                }
                catch {
                    throw new Error(`OpenAICompat: failed to parse model JSON: ${content.slice(0, 200)}`);
                }
                const rawUsage = response.usage;
                const usage = {
                    prompt_tokens: rawUsage?.prompt_tokens ?? 0,
                    completion_tokens: rawUsage?.completion_tokens ?? 0,
                    total_tokens: rawUsage?.total_tokens ?? 0,
                };
                const callTrace = {
                    model: this.modelInfo,
                    temperature: input.temperature,
                    prompt_version: input.promptVersion,
                    latency_ms: 0, // intentionally 0 — latency not recorded in traces
                    usage,
                    fallback_used: false,
                };
                return { data, usage, callTrace };
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
            }
        }
        throw lastError;
    }
}
exports.OpenAICompatAdapter = OpenAICompatAdapter;
//# sourceMappingURL=openai_compat.js.map