import { Action, Observation, Thought } from "../types/react";
export interface Agent {
    name: string;
    think(ctx: {
        userInput: string;
        history: Array<{
            thought: Thought;
            action?: Action;
            observation?: Observation;
        }>;
    }): Promise<Thought>;
    act(thought: Thought): Promise<Action | null>;
}
//# sourceMappingURL=agent.d.ts.map