import { Agent } from "../runtime/agent";
import { Action, Thought } from "../types/react";
export type Intent = {
    city: string | null;
    type: "food" | "culture" | "mixed" | "unknown";
    tags: string[];
    cz_seed: string[];
    ez_seed: string[];
    raw_text: string;
    confidence: number;
};
export declare class IntentAgent implements Agent {
    name: string;
    think(ctx: {
        userInput: string;
    }): Promise<Thought>;
    act(thought: Thought): Promise<Action | null>;
}
//# sourceMappingURL=intentAgent.d.ts.map