"use strict";
/**
 * TagNormalize skill — deterministic normalization from expanded tags to the
 * ontology standard tag space.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTagNormalizeSkill = createTagNormalizeSkill;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const RULE_ID = "tag_normalize_v1";
const SCHEMA_VERSION = "1.0";
let cachedIndex = null;
function normalizeForMatch(raw) {
    return raw
        .toLowerCase()
        .trim()
        .replace(/-/g, "_")
        .replace(/[^a-z0-9_ ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function tokenize(raw) {
    const normalized = normalizeForMatch(raw);
    if (!normalized) {
        return [];
    }
    return normalized
        .split(/[_\s]+/)
        .map((token) => token.trim())
        .filter(Boolean);
}
function isSubset(a, b) {
    for (const token of a) {
        if (!b.has(token)) {
            return false;
        }
    }
    return true;
}
function isFuzzyEligible(inputNormalized, inputTokens) {
    if (inputNormalized.length < 4) {
        return false;
    }
    if (inputTokens.length === 0) {
        return false;
    }
    for (const token of inputTokens) {
        if (token.length < 2) {
            return false;
        }
    }
    return true;
}
function parseTagDictionary(fileContent) {
    const standardByCanonical = new Map();
    const aliasByCanonical = new Map();
    let currentStandard = null;
    let inAliases = false;
    for (const rawLine of fileContent.split(/\r?\n/)) {
        const line = rawLine.replace(/\t/g, "    ");
        const trimmed = line.trim();
        if (!trimmed || /^#/.test(trimmed)) {
            continue;
        }
        if (/^\S/.test(line)) {
            const topLevelMatch = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*$/);
            if (topLevelMatch) {
                const standard = topLevelMatch[1];
                if (!standard) {
                    currentStandard = null;
                    inAliases = false;
                    continue;
                }
                currentStandard = standard;
                inAliases = false;
                const canonical = normalizeForMatch(currentStandard);
                if (canonical) {
                    standardByCanonical.set(canonical, currentStandard);
                }
            }
            else {
                currentStandard = null;
                inAliases = false;
            }
            continue;
        }
        if (!currentStandard) {
            continue;
        }
        if (/^aliases:\s*$/.test(trimmed)) {
            inAliases = true;
            continue;
        }
        if (!inAliases) {
            continue;
        }
        const aliasMatch = trimmed.match(/^-\s+(.+)$/);
        if (!aliasMatch) {
            continue;
        }
        const aliasValue = aliasMatch[1];
        if (!aliasValue) {
            continue;
        }
        const aliasRaw = aliasValue.trim().replace(/^['"]|['"]$/g, "");
        const canonicalAlias = normalizeForMatch(aliasRaw);
        if (!canonicalAlias) {
            continue;
        }
        if (!aliasByCanonical.has(canonicalAlias)) {
            aliasByCanonical.set(canonicalAlias, currentStandard);
        }
    }
    const standards = Array.from(standardByCanonical.entries())
        .map(([canonical, standard]) => ({
        standard,
        canonical,
        tokens: tokenize(canonical),
    }))
        .sort((a, b) => a.canonical.localeCompare(b.canonical));
    return { standardByCanonical, aliasByCanonical, standards };
}
function loadDictionaryIndex() {
    if (cachedIndex) {
        return cachedIndex;
    }
    const dictionaryPath = path_1.default.resolve(__dirname, "../../../services/ontology/tag_dictionary.yaml");
    const content = fs_1.default.readFileSync(dictionaryPath, "utf8");
    cachedIndex = parseTagDictionary(content);
    return cachedIndex;
}
function tokenSafeSubsetMatch(inputNormalized, inputTokens, index) {
    if (!isFuzzyEligible(inputNormalized, inputTokens)) {
        return null;
    }
    const inputSet = new Set(inputTokens);
    const matches = [];
    for (const candidate of index.standards) {
        if (candidate.tokens.length === 0) {
            continue;
        }
        const canonicalSet = new Set(candidate.tokens);
        const matched = isSubset(inputSet, canonicalSet) || isSubset(canonicalSet, inputSet);
        if (matched) {
            matches.push(candidate);
        }
    }
    if (matches.length === 0) {
        return null;
    }
    matches.sort((a, b) => {
        if (a.tokens.length !== b.tokens.length) {
            return a.tokens.length - b.tokens.length;
        }
        return a.canonical.localeCompare(b.canonical);
    });
    const bestMatch = matches[0];
    return bestMatch ? bestMatch.standard : null;
}
function extractInputTags(input) {
    if (Array.isArray(input.tags_final)) {
        return input.tags_final.filter((value) => typeof value === "string");
    }
    const candidate = input.tag_expand;
    if (candidate && typeof candidate === "object") {
        const fromNested = candidate.tags_final;
        if (Array.isArray(fromNested)) {
            return fromNested.filter((value) => typeof value === "string");
        }
    }
    return [];
}
function createTagNormalizeSkill() {
    return {
        name: "tag_normalize",
        inputSchema: {
            description: "Expanded tags and intent context for deterministic ontology normalization",
            required: ["tags_final", "intent"],
        },
        outputSchema: {
            description: "Normalized tags + mapping + drop report + trace bundle",
            required: ["normalized_tags", "mapping", "dropped", "decision_trace"],
        },
        async execute(input) {
            let index = null;
            try {
                index = loadDictionaryIndex();
            }
            catch {
                index = null;
            }
            const mappingObject = {};
            const droppedObject = {};
            const normalizedTags = [];
            const seenNormalized = new Set();
            const inputTags = extractInputTags(input);
            for (const originalRaw of inputTags) {
                const original = typeof originalRaw === "string" ? originalRaw : "";
                const cleaned = normalizeForMatch(original);
                const inputTokens = tokenize(original);
                if (!cleaned || inputTokens.length === 0) {
                    droppedObject[original] = "not_in_dictionary";
                    continue;
                }
                if (!index) {
                    droppedObject[original] = "not_in_dictionary";
                    continue;
                }
                let normalized = null;
                if (index.standardByCanonical.has(cleaned)) {
                    normalized = index.standardByCanonical.get(cleaned) ?? null;
                }
                else if (index.aliasByCanonical.has(cleaned)) {
                    normalized = index.aliasByCanonical.get(cleaned) ?? null;
                }
                else {
                    normalized = tokenSafeSubsetMatch(cleaned, inputTokens, index);
                }
                if (!normalized) {
                    droppedObject[original] = "not_in_dictionary";
                    continue;
                }
                mappingObject[original] = normalized;
                if (!seenNormalized.has(normalized)) {
                    seenNormalized.add(normalized);
                    normalizedTags.push(normalized);
                }
            }
            const traceNode = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                mapping: mappingObject,
                dropped: droppedObject,
                normalized_tags: normalizedTags,
            };
            const output = {
                normalized_tags: normalizedTags,
                mapping: mappingObject,
                dropped: droppedObject,
                decision_trace: {
                    tag_normalize: traceNode,
                },
            };
            return {
                output,
                trace: traceNode,
            };
        },
    };
}
//# sourceMappingURL=tag_normalize.js.map