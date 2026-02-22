/**
 * TagNormalize skill — deterministic normalization from expanded tags to the
 * ontology standard tag space.
 */

import fs from "fs";
import path from "path";
import { Skill, TagNormalizeInput, TagNormalizeOutput } from "../core/types";

const RULE_ID = "tag_normalize_v1";
const SCHEMA_VERSION = "1.0";

interface DictionaryStandard {
    standard: string;
    canonical: string;
    tokens: string[];
}

interface DictionaryIndex {
    standardByCanonical: Map<string, string>;
    aliasByCanonical: Map<string, string>;
    standards: DictionaryStandard[];
}

let cachedIndex: DictionaryIndex | null = null;

function normalizeForMatch(raw: string): string {
    return raw
        .toLowerCase()
        .trim()
        .replace(/-/g, "_")
        .replace(/[^a-z0-9_ ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenize(raw: string): string[] {
    const normalized = normalizeForMatch(raw);
    if (!normalized) {
        return [];
    }
    return normalized
        .split(/[_\s]+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
    for (const token of a) {
        if (!b.has(token)) {
            return false;
        }
    }
    return true;
}

function isFuzzyEligible(inputNormalized: string, inputTokens: string[]): boolean {
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

function parseTagDictionary(fileContent: string): DictionaryIndex {
    const standardByCanonical = new Map<string, string>();
    const aliasByCanonical = new Map<string, string>();

    let currentStandard: string | null = null;
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
            } else {
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

    const standards: DictionaryStandard[] = Array.from(standardByCanonical.entries())
        .map(([canonical, standard]) => ({
            standard,
            canonical,
            tokens: tokenize(canonical),
        }))
        .sort((a, b) => a.canonical.localeCompare(b.canonical));

    return { standardByCanonical, aliasByCanonical, standards };
}

function loadDictionaryIndex(): DictionaryIndex {
    if (cachedIndex) {
        return cachedIndex;
    }

    const dictionaryPath = path.resolve(__dirname, "../../../services/ontology/tag_dictionary.yaml");
    const content = fs.readFileSync(dictionaryPath, "utf8");
    cachedIndex = parseTagDictionary(content);
    return cachedIndex;
}

function tokenSafeSubsetMatch(
    inputNormalized: string,
    inputTokens: string[],
    index: DictionaryIndex
): string | null {
    if (!isFuzzyEligible(inputNormalized, inputTokens)) {
        return null;
    }

    const inputSet = new Set(inputTokens);
    const matches: DictionaryStandard[] = [];

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

function extractInputTags(input: TagNormalizeInput & Record<string, unknown>): string[] {
    if (Array.isArray(input.tags_final)) {
        return input.tags_final.filter((value): value is string => typeof value === "string");
    }

    const candidate = input.tag_expand;
    if (candidate && typeof candidate === "object") {
        const fromNested = (candidate as { tags_final?: unknown }).tags_final;
        if (Array.isArray(fromNested)) {
            return fromNested.filter((value): value is string => typeof value === "string");
        }
    }

    return [];
}

export function createTagNormalizeSkill(): Skill<TagNormalizeInput, TagNormalizeOutput> {
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

        async execute(input: TagNormalizeInput): Promise<{ output: TagNormalizeOutput; trace: Record<string, unknown> }> {
            let index: DictionaryIndex | null = null;
            try {
                index = loadDictionaryIndex();
            } catch {
                index = null;
            }

            const mappingObject: Record<string, string> = {};
            const droppedObject: Record<string, string> = {};
            const normalizedTags: string[] = [];
            const seenNormalized = new Set<string>();

            const inputTags = extractInputTags(input as TagNormalizeInput & Record<string, unknown>);

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

                let normalized: string | null = null;

                if (index.standardByCanonical.has(cleaned)) {
                    normalized = index.standardByCanonical.get(cleaned) ?? null;
                } else if (index.aliasByCanonical.has(cleaned)) {
                    normalized = index.aliasByCanonical.get(cleaned) ?? null;
                } else {
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
            } as unknown as TagNormalizeOutput;

            return {
                output,
                trace: traceNode,
            };
        },
    };
}
