import { Agent } from "../runtime/agent";
import { Action, Thought } from "../types/react";
export declare class MVPAgent implements Agent {
    name: string;
    think(ctx: {
        userInput: string;
    }): Promise<Thought>;
    act(thought: Thought): Promise<Action | null>;
}
//# sourceMappingURL=mvpAgent.d.ts.map