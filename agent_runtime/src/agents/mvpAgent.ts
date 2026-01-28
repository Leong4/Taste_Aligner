import { Agent } from "../runtime/agent";
import { Action, Thought } from "../types/react";

export class MVPAgent implements Agent {
    name = "mvp-agent";

    async think(ctx: { userInput: string }): Promise<Thought> {
        // MVP: minimal rule-based intent extraction (English only for now)
        const text = ctx.userInput.toLowerCase();
        const city = text.includes("london") ? "london" : "unknown";

        return {
            text: `I should call planner.compose for city=${city}`,
            done: false,
            state: { city },
        };
    }

    async act(thought: Thought): Promise<Action | null> {
        const city = thought.state?.city ?? "unknown";
        return {
            tool: "planner.compose",
            input: { city, cz: ["ramen_shop", "izakaya"], ez: ["temple", "park"], user_id: "u001" },
        };
    }
}
