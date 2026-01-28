import axios, { AxiosInstance } from "axios";
import { Action, Observation } from "../types/react";

type ToolClientOpts = {
    gatewayBaseUrl: string;     // e.g. http://localhost:8080
    timeoutMs?: number;         // e.g. 3000
    logPayload?: boolean;       // debug 用
};

export class ToolClient {
    private http: AxiosInstance;
    private baseUrl: string;
    private timeoutMs: number;
    private logPayload: boolean;

    constructor(opts: ToolClientOpts) {
        this.baseUrl = opts.gatewayBaseUrl.replace(/\/$/, "");
        this.timeoutMs = opts.timeoutMs ?? 3000;
        this.logPayload = opts.logPayload ?? false;

        this.http = axios.create({
            baseURL: this.baseUrl,
            timeout: this.timeoutMs,
            headers: { "Content-Type": "application/json" },
            validateStatus: () => true, // 我们自己处理非 2xx
        });
    }

    async call(action: Action): Promise<Observation> {
        const traceId = this.newTraceId();
        const started = Date.now();

        // 轻量校验：防止空 tool / 非对象 input
        if (!action?.tool || typeof action.tool !== "string") {
            return this.fail("bad_action", "action.tool missing", traceId, 0, { action });
        }
        const input = action.input ?? {};
        if (typeof input !== "object" || Array.isArray(input)) {
            return this.fail("bad_action", "action.input must be object", traceId, 0, { action });
        }

        const path = `/tool/${action.tool}`;
        try {
            if (this.logPayload) {
                console.log(`[toolClient] -> ${path}`, { traceId, input });
            }

            const resp = await this.http.post(path, input);
            const latencyMs = Date.now() - started;

            if (resp.status >= 200 && resp.status < 300) {
                return {
                    ok: true,
                    tool: action.tool,
                    trace_id: traceId,
                    latency_ms: latencyMs,
                    output: resp.data,
                };
            }

            // Gateway 返回的错误也统一包装
            return this.fail(
                "gateway_error",
                `gateway responded ${resp.status}`,
                traceId,
                latencyMs,
                { status: resp.status, data: resp.data }
            );
        } catch (e: any) {
            const latencyMs = Date.now() - started;
            // axios 超时会走这里
            return this.fail(
                "network_error",
                e?.message ?? "request failed",
                traceId,
                latencyMs,
                { tool: action.tool }
            );
        }
    }

    private fail(code: string, message: string, traceId: string, latencyMs: number, meta?: any): Observation {
        return {
            ok: false,
            tool: meta?.tool ?? "unknown",
            trace_id: traceId,
            latency_ms: latencyMs,
            error: { code, message, meta },
        };
    }

    private newTraceId(): string {
        return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
}