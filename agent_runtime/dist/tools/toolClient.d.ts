import { Action, Observation } from "../types/react";
type ToolClientOpts = {
    gatewayBaseUrl: string;
    timeoutMs?: number;
    logPayload?: boolean;
};
export declare class ToolClient {
    private http;
    private baseUrl;
    private timeoutMs;
    private logPayload;
    constructor(opts: ToolClientOpts);
    call(action: Action): Promise<Observation>;
    private fail;
    private newTraceId;
}
export {};
//# sourceMappingURL=toolClient.d.ts.map