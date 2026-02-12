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

export class SkillRegistry {
    private skills: Map<string, Skill> = new Map();

    /**
     * Register a skill. Throws if a skill with the same name already exists.
     */
    register(skill: Skill): void {
        if (this.skills.has(skill.name)) {
            throw new Error(
                `[SkillRegistry] Skill "${skill.name}" is already registered. ` +
                `Duplicate registration is not allowed.`
            );
        }
        this.skills.set(skill.name, skill);
    }

    /**
     * Retrieve a skill by name. Throws if not found.
     */
    get(skillName: string): Skill {
        const skill = this.skills.get(skillName);
        if (!skill) {
            throw new Error(
                `[SkillRegistry] Skill "${skillName}" not found. ` +
                `Registered skills: [${this.list().join(", ")}]`
            );
        }
        return skill;
    }

    /**
     * Check if a skill is registered.
     */
    has(skillName: string): boolean {
        return this.skills.has(skillName);
    }

    /**
     * List all registered skill names.
     */
    list(): string[] {
        return Array.from(this.skills.keys());
    }

    /**
     * Return count of registered skills.
     */
    get size(): number {
        return this.skills.size;
    }
}
