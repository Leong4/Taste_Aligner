/**
 * caption_sentiment skill
 *
 * Caption sentiment is a text signal and deliberately does not depend on the
 * configured image backend. The deterministic local analyser keeps the
 * default clip_v1 path useful without pretending that a missing score is a
 * measured neutral opinion.
 */
import { CaptionSentimentInput, CaptionSentimentOutput, Skill } from "../core/types";
export declare function analyzeCaptionSentiment(captionInput: unknown): CaptionSentimentOutput;
export declare const captionSentimentSkill: Skill<CaptionSentimentInput, CaptionSentimentOutput>;
//# sourceMappingURL=caption_sentiment.d.ts.map