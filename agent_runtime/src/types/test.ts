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

    // 成功输出
    output?: any;

    // 失败结构
    error?: {
        code: string;
        message: string;
        meta?: any;
    };
};

export type Thought = {
    text: string;
    done?: boolean;
    // 可以附带结构化意图，后面接 Intent Agent 会用到
    state?: Record<string, any>;
};