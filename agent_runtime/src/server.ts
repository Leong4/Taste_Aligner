import http from "node:http";
import { IntentAgent } from "./agents/intentAgent";
import { ReActRuntime } from "./runtime/reactRuntime";
import { ToolClient } from "./tools/toolClient";

const PORT = Number(process.env.AGENT_SERVER_PORT ?? 8787);

const agent = new IntentAgent();
const gatewayBaseUrl = process.env.GATEWAY_BASE_URL ?? "http://localhost:8080";
const timeoutMs = process.env.GATEWAY_TIMEOUT_MS
    ? Number(process.env.GATEWAY_TIMEOUT_MS)
    : 3000;

const toolClient = new ToolClient({
    gatewayBaseUrl,
    timeoutMs,
    logPayload: true,
});

const runtime = new ReActRuntime(agent, toolClient, { maxTurns: 3 });

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

        const history = await runtime.run(text);
        const last = history[history.length - 1];
        const state = last?.thought?.state ?? {};
        const observation = last?.observation;
        const output = observation?.output ?? null;

        sendJson(res, 200, {
            ok: observation?.ok ?? false,
            city: state.city ?? null,
            type: state.type ?? "unknown",
            tool: observation?.tool ?? null,
            observation: observation ?? null,
            output,
            history,
        });
    } catch (err: any) {
        sendJson(res, 500, { error: "server_error", message: err?.message ?? "unknown" });
    }
});

server.listen(PORT, () => {
    console.log(`[agent_runtime] server listening on http://localhost:${PORT}`);
});
