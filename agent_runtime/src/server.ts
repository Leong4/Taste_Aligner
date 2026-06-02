/**
 * HTTP server for the Taste Aligner agent runtime.
 *
 * Exposes a single POST /run endpoint that accepts user text and
 * returns recommendation cards with full decision_trace.
 *
 * Architecture: Uses SkillRegistry + Graph + Orchestrator instead
 * of the previous ReActRuntime + IntentAgent pattern.
 */

import http from "node:http";
import { createOrchestrator } from "./core/bootstrap";
import { OpenAICompatAdapter } from "./llm";

const PORT = Number(process.env.PORT ?? process.env.AGENT_SERVER_PORT ?? 8787);

const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8080";
const timeoutMs = process.env.GATEWAY_TIMEOUT_MS
    ? Number(process.env.GATEWAY_TIMEOUT_MS)
    : 3000;

const orchestrator = createOrchestrator({
    gatewayBaseUrl,
    timeoutMs,
    logPayload: true,
});

const geocodeApiKey = process.env.LLM_API_KEY;
const geocodeAdapterOptions = geocodeApiKey
    ? {
        apiKey: geocodeApiKey,
        model: process.env.LLM_GEOCODE_MODEL ?? "gpt-4o",
    }
    : null;
if (geocodeAdapterOptions && process.env.LLM_BASE_URL) {
    Object.assign(geocodeAdapterOptions, { baseUrl: process.env.LLM_BASE_URL });
}
const geocodeAdapter = geocodeAdapterOptions
    ? new OpenAICompatAdapter(geocodeAdapterOptions)
    : null;

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += chunk;
        });
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (err) {
                reject(err);
            }
        });
    });
}

const server = http.createServer(async (req, res) => {
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

    if (req.method === "POST" && req.url === "/geocode/uk-location") {
        try {
            const body = await readJson(req);
            const city = typeof body.city === "string" ? body.city.trim() : "";
            const validLocations = Array.isArray(body.valid_locations)
                ? body.valid_locations.filter((value: unknown): value is string => typeof value === "string")
                : [];

            if (!city) {
                sendJson(res, 400, { error: "city_required" });
                return;
            }
            if (!geocodeAdapter) {
                sendJson(res, 503, { error: "llm_not_configured" });
                return;
            }

            const result = await geocodeAdapter.generateStructuredJSON<{ location: string | null }>({
                systemPrompt:
                    "You resolve UK city names to exact local-authority names. " +
                    "Return JSON with exactly one key named location. " +
                    "The value must be one exact case-sensitive string from the supplied valid locations, or null.",
                userPrompt:
                    `Given the city name '${city}', return the exact UK county or unitary authority name ` +
                    "as it appears in the ONS GeoJSON data. Return only the matching name string in the " +
                    "location field, nothing else. If the city is not in the UK, return null.\n\n" +
                    `Valid locations:\n${validLocations.join("\n")}`,
                schema: {
                    type: "object",
                    properties: {
                        location: { type: ["string", "null"] },
                    },
                    required: ["location"],
                    additionalProperties: false,
                },
                temperature: 0,
                promptVersion: "uk_location_geocode_v1",
                traceContext: { city },
            });

            const location = typeof result.data?.location === "string"
                ? result.data.location
                : null;
            if (location !== null && !validLocations.includes(location)) {
                console.warn(`[geocode] No exact UK LAD match for city="${city}": "${location}"`);
                sendJson(res, 200, { location: null });
                return;
            }

            sendJson(res, 200, { location });
        } catch (err: any) {
            sendJson(res, 500, { error: "geocode_failed", message: err?.message ?? "unknown" });
        }
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

        const orchInput: {
            text: string;
            user_id?: string;
            image_url?: string;
            image_base64?: string;
            image_original_base64?: string;
            caption?: string;
            city?: string;
        } = { text };
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
    } catch (err: any) {
        sendJson(res, 500, { error: "server_error", message: err?.message ?? "unknown" });
    }
});

server.listen(PORT, () => {
    console.log(`[agent_runtime] server listening on http://localhost:${PORT}`);
});
