/**
 * SkillRegistry — central registry for all executable skills.
 *
 * Skills are registered once at startup and looked up by name during
 * graph execution. The registry enforces unique names and provides
 * introspection (list all registered skills).
 *
 * This is the single source of truth for what capabilities the system has.
 * Adding a new skill (deterministic or LLM-based) means:
 *   1. Implement the Skill interface
 *   2. Register it here
 *   3. Add a node to the graph definition
 */
import { Skill } from "./types";
export declare class SkillRegistry {
    private skills;
    /**
     * Register a skill. Throws if a skill with the same name already exists.
     */
    register(skill: Skill): void;
    /**
     * Retrieve a skill by name. Throws if not found.
     */
    get(skillName: string): Skill;
    /**
     * Check if a skill is registered.
     */
    has(skillName: string): boolean;
    /**
     * List all registered skill names.
     */
    list(): string[];
    /**
     * Return count of registered skills.
     */
    get size(): number;
}
//# sourceMappingURL=skill_registry.d.ts.map