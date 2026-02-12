import { Agent } from "./agent";
import { ToolClient } from "../tools/toolClient";
import { Action, Observation, Thought } from "../types/react";
export declare class ReActRuntime {
    private agent;
    private toolClient;
    private opts;
    constructor(agent: Agent, toolClient: ToolClient, opts?: {
        maxTurns: number;
    });
    run(userInput: string): Promise<{
        thought: Thought;
        action?: Action;
        observation?: Observation;
    }[]>;
}
//# sourceMappingURL=reactRuntime.d.ts.map