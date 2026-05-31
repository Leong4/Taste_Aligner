/**
 * ExtractIntent skill — wraps the existing deterministic intent
 * extraction logic from IntentAgent.
 *
 * This skill extracts city, type, tags, and zone seeds from raw
 * user text using regex patterns and keyword matching.
 * NO LLM involved — purely rule-based.
 *
 * The logic is copied directly from agents/intentAgent.ts to avoid
 * importing the Agent interface. The business rules are identical.
 */
import { Skill, ExtractIntentOutput } from "../core/types";
export declare const extractIntentSkill: Skill<{
    text: string;
    user_id?: string;
    city?: string;
    image_url?: string;
    image_base64?: string;
}, ExtractIntentOutput>;
//# sourceMappingURL=extract_intent.d.ts.map