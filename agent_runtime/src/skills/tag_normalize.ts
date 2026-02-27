/**
 * TagNormalize skill — deterministic normalization from expanded tags to the
 * ontology standard tag space.
 *
 * Prefers the remote ontology.normalize gateway tool when a toolClient is
 * supplied.  Falls back to local dictionary matching on any error.
 */

import fs from "fs";
import path from "path";
import { Skill, TagNormalizeInput, TagNormalizeOutput } from "../core/types";

const RULE_ID = "tag_normalize_v1";
const SCHEMA_VERSION = "1.0";
const TOOL_NAME = "ontology.normalize";

// Duck-typed to avoid circular imports and keep tests stub-friendly.
interface ToolClientLike {
    call(action: { tool: string; input: Record<string, unknown> }): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Local dictionary types + parsing (unchanged from original)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Local normalization — extracted as pure function for fallback use
// ---------------------------------------------------------------------------

interface LocalNormalizeResult {
    normalizedTags: string[];
    mappingObject: Record<string, string>;
    droppedObject: Record<string, string>;
}

function localNormalize(inputTags: string[], index: DictionaryIndex | null): LocalNormalizeResult {
    const mappingObject: Record<string, string> = {};
    const droppedObject: Record<string, string> = {};
    const normalizedTags: string[] = [];
    const seenNormalized = new Set<string>();

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

    return { normalizedTags, mappingObject, droppedObject };
}

// ---------------------------------------------------------------------------
// Remote ontology call
// ---------------------------------------------------------------------------

type FallbackReason = "no_tags" | "tool_error" | "invalid_output" | "service_not_ok";

type RemoteResult =
    | { ok: true; normalizedTags: string[] }
    | { ok: false; reason: Exclude<FallbackReason, "no_tags"> };

async function tryOntologyNormalize(
    toolClient: ToolClientLike,
    tags: string[]
): Promise<RemoteResult> {
    let observation: unknown;
    try {
        observation = await toolClient.call({
            tool: TOOL_NAME,
            input: { data: { tags, lang: "auto", strict: true } },
        });
    } catch {
        return { ok: false, reason: "tool_error" };
    }

    if (!observation || typeof observation !== "object") {
        return { ok: false, reason: "invalid_output" };
    }

    const obs = observation as Record<string, unknown>;

    if (obs.ok === false) {
        return { ok: false, reason: "service_not_ok" };
    }

    // Gateway wraps service response in output; accept from either location.
    const output = obs.output as Record<string, unknown> | undefined;
    const rawTags = (output?.normalized_tags ?? obs.normalized_tags) as unknown;

    if (!Array.isArray(rawTags)) {
        return { ok: false, reason: "invalid_output" };
    }

    for (const item of rawTags) {
        if (typeof item !== "string") {
            return { ok: false, reason: "invalid_output" };
        }
    }

    // Deterministic post-processing: trim -> lowercase -> filter empty -> dedupe -> stable sort.
    const seen = new Set<string>();
    const normalizedTags: string[] = [];
    for (const tag of rawTags as string[]) {
        const cleaned = tag.trim().toLowerCase();
        if (!cleaned || seen.has(cleaned)) continue;
        seen.add(cleaned);
        normalizedTags.push(cleaned);
    }
    normalizedTags.sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );

    return { ok: true, normalizedTags };
}

// ---------------------------------------------------------------------------
// Skill factory
// ---------------------------------------------------------------------------

export function createTagNormalizeSkill(
    toolClient?: ToolClientLike
): Skill<TagNormalizeInput, TagNormalizeOutput> {
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
            const inputTags = extractInputTags(input as TagNormalizeInput & Record<string, unknown>);

            // ── no_tags: skip tool call entirely ──────────────────────────
            if (inputTags.length === 0) {
                const traceNode = {
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    provider: "local" as const,
                    used: false,
                    fallback_used: true,
                    fallback_reason: "no_tags" as FallbackReason,
                    mapping: {},
                    dropped: {},
                    normalized_tags: [] as string[],
                };
                const output = {
                    normalized_tags: [],
                    mapping: {},
                    dropped: {},
                    decision_trace: { tag_normalize: traceNode },
                } as unknown as TagNormalizeOutput;
                return { output, trace: traceNode };
            }

            // ── try remote ontology.normalize ─────────────────────────────
            if (toolClient) {
                const remoteResult = await tryOntologyNormalize(toolClient, inputTags);

                if (remoteResult.ok) {
                    const traceNode = {
                        rule_id: RULE_ID,
                        schema_version: SCHEMA_VERSION,
                        provider: "ontology" as const,
                        tool: { name: TOOL_NAME },
                        used: true,
                        fallback_used: false,
                        mapping: {},
                        dropped: {},
                        normalized_tags: remoteResult.normalizedTags,
                    };
                    const output = {
                        normalized_tags: remoteResult.normalizedTags,
                        mapping: {},
                        dropped: {},
                        decision_trace: { tag_normalize: traceNode },
                    } as unknown as TagNormalizeOutput;
                    return { output, trace: traceNode };
                }

                // remote failed → fall through to local
                const fallbackReason: FallbackReason = remoteResult.reason;
                let index: DictionaryIndex | null = null;
                try { index = loadDictionaryIndex(); } catch { index = null; }

                const { normalizedTags, mappingObject, droppedObject } = localNormalize(inputTags, index);

                const traceNode = {
                    rule_id: RULE_ID,
                    schema_version: SCHEMA_VERSION,
                    provider: "local" as const,
                    used: false,
                    fallback_used: true,
                    fallback_reason: fallbackReason,
                    mapping: mappingObject,
                    dropped: droppedObject,
                    normalized_tags: normalizedTags,
                };
                const output = {
                    normalized_tags: normalizedTags,
                    mapping: mappingObject,
                    dropped: droppedObject,
                    decision_trace: { tag_normalize: traceNode },
                } as unknown as TagNormalizeOutput;
                return { output, trace: traceNode };
            }

            // ── no toolClient: pure local path ────────────────────────────
            let index: DictionaryIndex | null = null;
            try { index = loadDictionaryIndex(); } catch { index = null; }

            const { normalizedTags, mappingObject, droppedObject } = localNormalize(inputTags, index);

            const traceNode = {
                rule_id: RULE_ID,
                schema_version: SCHEMA_VERSION,
                provider: "local" as const,
                used: false,
                fallback_used: false,
                mapping: mappingObject,
                dropped: droppedObject,
                normalized_tags: normalizedTags,
            };
            const output = {
                normalized_tags: normalizedTags,
                mapping: mappingObject,
                dropped: droppedObject,
                decision_trace: { tag_normalize: traceNode },
            } as unknown as TagNormalizeOutput;
            return { output, trace: traceNode };
        },
    };
}
