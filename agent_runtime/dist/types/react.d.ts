export type ToolName = string;
export type Action = {
    tool: ToolName;
    input: Record<string, any>;
};
export type Observation = {
    ok: boolean;
    tool: string;
    trace_id?: string;
    latency_ms?: number;
    output?: any;
    error?: {
        code: string;
        message: string;
        meta?: any;
    };
};
export type Thought = {
    text: string;
    done?: boolean;
    state?: Record<string, any>;
};
//# sourceMappingURL=react.d.ts.map