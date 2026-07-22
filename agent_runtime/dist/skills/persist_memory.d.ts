/**
 * persist_memory skill
 *
 * Upload persistence is a confirmed graph step, not a fire-and-forget side
 * effect. The skill waits for Memory Service acknowledgement, retries bounded
 * transient failures with the same memory_id, and reports honest status.
 */
import { PersistMemoryInput, PersistMemoryOutput, Skill } from "../core/types";
export declare function createPersistMemorySkill(): Skill<PersistMemoryInput, PersistMemoryOutput>;
//# sourceMappingURL=persist_memory.d.ts.map