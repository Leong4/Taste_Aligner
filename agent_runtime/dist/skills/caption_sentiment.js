"use strict";
/**
 * caption_sentiment skill
 *
 * Caption sentiment is a text signal and deliberately does not depend on the
 * configured image backend. The deterministic local analyser keeps the
 * default clip_v1 path useful without pretending that a missing score is a
 * measured neutral opinion.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.captionSentimentSkill = void 0;
exports.analyzeCaptionSentiment = analyzeCaptionSentiment;
const RULE_ID = "caption_sentiment_v1";
const SCHEMA_VERSION = "1.0";
const ENGLISH_SCORES = {
    amazing: 1,
    awesome: 0.95,
    excellent: 0.95,
    incredible: 0.95,
    perfect: 0.95,
    best: 0.95,
    love: 0.9,
    loved: 0.9,
    like: 0.6,
    liked: 0.6,
    favorite: 0.9,
    favourite: 0.9,
    delicious: 0.9,
    beautiful: 0.8,
    wonderful: 0.85,
    great: 0.75,
    enjoyed: 0.7,
    enjoy: 0.7,
    recommend: 0.65,
    nice: 0.55,
    good: 0.55,
    fun: 0.5,
    interesting: 0.35,
    okay: 0.05,
    ok: 0.05,
    fine: 0.05,
    average: -0.1,
    mediocre: -0.3,
    terrible: -1,
    awful: -1,
    worst: -1,
    hate: -0.95,
    hated: -0.95,
    disgusting: -0.95,
    disappointing: -0.8,
    disappointed: -0.8,
    regret: -0.8,
    bad: -0.7,
    dirty: -0.65,
    poor: -0.6,
    boring: -0.6,
    bland: -0.5,
    overpriced: -0.5,
    crowded: -0.35,
};
const NEGATORS = new Set([
    "not", "no", "never", "hardly", "isnt", "wasnt", "didnt", "dont", "doesnt",
]);
const INTENSIFIERS = new Set(["very", "really", "extremely", "super", "so", "absolutely"]);
const CHINESE_SIGNALS = [
    ["非常喜欢", 1], ["超级喜欢", 1], ["太喜欢", 0.95], ["最喜欢", 0.95],
    ["太棒了", 0.95], ["非常棒", 0.95], ["超棒", 0.9], ["很棒", 0.85],
    ["太好吃", 0.95], ["非常好吃", 0.95], ["很好吃", 0.85], ["好吃", 0.75],
    ["非常美", 0.9], ["很漂亮", 0.85], ["漂亮", 0.7], ["惊艳", 0.9],
    ["值得推荐", 0.8], ["推荐", 0.65], ["喜欢", 0.7], ["满意", 0.65],
    ["开心", 0.6], ["还不错", 0.35], ["还行", 0.05], ["一般", -0.1],
    ["非常失望", -0.95], ["很失望", -0.85], ["失望", -0.75],
    ["太难吃", -1], ["非常难吃", -1], ["难吃", -0.9],
    ["太糟糕", -1], ["很糟糕", -0.9], ["糟糕", -0.85],
    ["非常讨厌", -1], ["很讨厌", -0.9], ["讨厌", -0.8],
    ["不喜欢", -0.75], ["不好吃", -0.8], ["不好", -0.6],
    ["后悔", -0.8], ["太差", -0.9], ["很差", -0.8], ["差劲", -0.85],
    ["无聊", -0.6], ["太贵", -0.5], ["拥挤", -0.35], ["踩雷", -0.85],
];
function round4(value) {
    return Number(value.toFixed(4));
}
function clampSigned(value) {
    return Math.max(-1, Math.min(1, value));
}
function englishSignals(caption) {
    const words = caption
        .toLowerCase()
        .replace(/[’']/g, "")
        .match(/[a-z]+/g) ?? [];
    const signals = [];
    for (let index = 0; index < words.length; index++) {
        const word = words[index];
        const base = ENGLISH_SCORES[word];
        if (base === undefined)
            continue;
        const previous = words.slice(Math.max(0, index - 2), index);
        const negated = previous.some((candidate) => NEGATORS.has(candidate));
        const intensified = previous.some((candidate) => INTENSIFIERS.has(candidate));
        let score = negated ? -base : base;
        if (intensified)
            score *= 1.2;
        signals.push({ term: negated ? `not_${word}` : word, score: clampSigned(score) });
    }
    return signals;
}
function chineseSignals(caption) {
    const signals = [];
    const occupied = new Set();
    for (const [term, score] of [...CHINESE_SIGNALS].sort((a, b) => b[0].length - a[0].length)) {
        let start = caption.indexOf(term);
        while (start >= 0) {
            const positions = Array.from({ length: term.length }, (_unused, offset) => start + offset);
            if (!positions.some((position) => occupied.has(position))) {
                positions.forEach((position) => occupied.add(position));
                signals.push({ term, score });
            }
            start = caption.indexOf(term, start + term.length);
        }
    }
    return signals;
}
function analyzeCaptionSentiment(captionInput) {
    const caption = typeof captionInput === "string" ? captionInput.trim() : "";
    if (!caption) {
        const trace = {
            rule_id: RULE_ID,
            schema_version: SCHEMA_VERSION,
            sentiment: 0,
            confidence: 0,
            available: false,
            source: "missing_caption",
            matched_terms: [],
            input_summary: { caption_present: false, character_count: 0, signal_count: 0 },
            fallback_used: true,
            fallback_reason: "missing_caption",
        };
        return {
            sentiment: 0,
            sentiment_scale: "signed_v1",
            sentiment_confidence: 0,
            sentiment_available: false,
            sentiment_source: "missing_caption",
            matched_terms: [],
            decision_trace: { caption_sentiment: trace },
        };
    }
    const signals = [...englishSignals(caption), ...chineseSignals(caption)];
    if (signals.length === 0) {
        const trace = {
            rule_id: RULE_ID,
            schema_version: SCHEMA_VERSION,
            sentiment: 0,
            confidence: 0,
            available: false,
            source: "no_sentiment_signal",
            matched_terms: [],
            input_summary: {
                caption_present: true,
                character_count: caption.length,
                signal_count: 0,
            },
            fallback_used: true,
            fallback_reason: "no_sentiment_signal",
        };
        return {
            sentiment: 0,
            sentiment_scale: "signed_v1",
            sentiment_confidence: 0,
            sentiment_available: false,
            sentiment_source: "no_sentiment_signal",
            matched_terms: [],
            decision_trace: { caption_sentiment: trace },
        };
    }
    const mean = signals.reduce((total, signal) => total + signal.score, 0) / signals.length;
    const exclamationBoost = /[!！]{2,}/.test(caption) ? 1.08 : 1;
    const sentiment = round4(clampSigned(mean * exclamationBoost));
    const meanStrength = signals.reduce((total, signal) => total + Math.abs(signal.score), 0) / signals.length;
    const confidence = round4(Math.min(0.95, 0.48 + 0.1 * signals.length + 0.32 * meanStrength));
    const matchedTerms = Array.from(new Set(signals.map((signal) => signal.term))).sort();
    const trace = {
        rule_id: RULE_ID,
        schema_version: SCHEMA_VERSION,
        sentiment,
        confidence,
        available: true,
        source: "caption_lexicon_v1",
        matched_terms: matchedTerms,
        input_summary: {
            caption_present: true,
            character_count: caption.length,
            signal_count: signals.length,
        },
        fallback_used: false,
    };
    return {
        sentiment,
        sentiment_scale: "signed_v1",
        sentiment_confidence: confidence,
        sentiment_available: true,
        sentiment_source: "caption_lexicon_v1",
        matched_terms: matchedTerms,
        decision_trace: { caption_sentiment: trace },
    };
}
exports.captionSentimentSkill = {
    name: "caption_sentiment",
    inputSchema: {
        description: "Analyse user caption sentiment on the canonical signed [-1, 1] scale",
        required: [],
        optional: ["caption"],
    },
    outputSchema: {
        description: "Signed caption sentiment with confidence and provenance",
        required: [
            "sentiment",
            "sentiment_scale",
            "sentiment_confidence",
            "sentiment_available",
            "sentiment_source",
            "matched_terms",
            "decision_trace",
        ],
    },
    async execute(input, _context) {
        const output = analyzeCaptionSentiment(input.caption);
        return { output, trace: output.decision_trace.caption_sentiment };
    },
};
//# sourceMappingURL=caption_sentiment.js.map