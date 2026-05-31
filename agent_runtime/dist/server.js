"use strict";
/**
 * HTTP server for the Taste Aligner agent runtime.
 *
 * Exposes a single POST /run endpoint that accepts user text and
 * returns recommendation cards with full decision_trace.
 *
 * Architecture: Uses SkillRegistry + Graph + Orchestrator instead
 * of the previous ReActRuntime + IntentAgent pattern.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = __importDefault(require("node:http"));
const bootstrap_1 = require("./core/bootstrap");
const PORT = Number(process.env.PORT ?? process.env.AGENT_SERVER_PORT ?? 8787);
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8080";
const timeoutMs = process.env.GATEWAY_TIMEOUT_MS
    ? Number(process.env.GATEWAY_TIMEOUT_MS)
    : 3000;
const orchestrator = (0, bootstrap_1.createOrchestrator)({
    gatewayBaseUrl,
    timeoutMs,
    logPayload: true,
});
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(payload);
}
function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
        });
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            }
            catch (err) {
                reject(err);
            }
        });
    });
}
const server = node_http_1.default.createServer(async (req, res) => {
    if (!req.url) {
        sendJson(res, 404, { error: "not_found" });
        return;
    }
    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
    }
    if (req.method !== "POST" || req.url !== "/run") {
        sendJson(res, 404, { error: "not_found" });
        return;
    }
    try {
        const body = await readJson(req);
        const text = typeof body.text === "string" ? body.text : "";
        if (!text) {
            sendJson(res, 400, { error: "text_required" });
            return;
        }
        const orchInput = { text };
        if (typeof body.user_id === "string") {
            orchInput.user_id = body.user_id;
        }
        if (typeof body.image_url === "string" && body.image_url.trim()) {
            orchInput.image_url = body.image_url;
        }
        if (typeof body.image_base64 === "string" && body.image_base64.trim()) {
            orchInput.image_base64 = body.image_base64;
        }
        if (typeof body.image_original_base64 === "string" && body.image_original_base64.trim()) {
            orchInput.image_original_base64 = body.image_original_base64;
        }
        if (!orchInput.image_base64 && orchInput.image_original_base64) {
            // Backward-compat: if caller only provides original image, keep previous behavior.
            orchInput.image_base64 = orchInput.image_original_base64;
        }
        if (typeof body.caption === "string") {
            orchInput.caption = body.caption;
        }
        if (typeof body.city === "string") {
            orchInput.city = body.city;
        }
        const result = await orchestrator.runWithTrace(orchInput);
        // Build response maintaining backward compatibility with the
        // existing frontend contract. The old response shape:
        //   { ok, city, type, tool, observation, output, history }
        //
        // The new response preserves these fields and adds
        // decision_trace, timing, and errors at the top level.
        sendJson(res, 200, {
            ok: result.ok,
            city: result.city,
            type: result.type,
            tool: result.ok ? "planner.compose" : null,
            observation: result.ok
                ? {
                    ok: true,
                    tool: "planner.compose",
                    output: {
                        ok: true,
                        cards: result.cards,
                        mix_policy: result.mix_policy,
                        decision_trace: result.decision_trace,
                    },
                }
                : null,
            output: result.ok
                ? {
                    ok: true,
                    cards: result.cards,
                    mix_policy: result.mix_policy,
                    decision_trace: result.decision_trace,
                }
                : null,
            explanation: result.explanation ?? null,
            bullets: result.bullets ?? null,
            decision_trace: result.decision_trace,
            timing: result.timing,
            errors: result.errors,
        });
    }
    catch (err) {
        sendJson(res, 500, { error: "server_error", message: err?.message ?? "unknown" });
    }
});
server.listen(PORT, () => {
    console.log(`[agent_runtime] server listening on http://localhost:${PORT}`);
});
//# sourceMappingURL=server.js.map