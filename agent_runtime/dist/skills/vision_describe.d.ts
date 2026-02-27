/**
 * vision_describe skill
 *
 * Calls the vision service via the gateway tool "vision.describe" and returns
 * a deterministic, normalised list of vision_features (tags) for downstream
 * TES enrichment.
 *
 * Determinism contract:
 *   - Tags are lowercased, trimmed, deduped, then sorted with
 *     localeCompare({ numeric: true, sensitivity: "base" }).
 *   - Up to MAX_TAGS tags are returned.
 *   - When no image is provided (no image_url AND no image_base64) the skill
 *     returns an empty vision_features list WITHOUT calling the gateway.
 *     fallback_reason is set to "no_image".
 *   - Any gateway / output error results in an empty list with
 *     fallback_used=true and an appropriate fallback_reason.
 *   - The skill never throws — all errors produce a fallback result.
 *
 * Decision trace written to decision_trace.vision_describe:
 *   used, backend, model_id, device, tags_count, latency_ms,
 *   fallback_used, fallback_reason, input_summary
 */
import { Skill, VisionDescribeInput, VisionDescribeOutput } from "../core/types";
import { ToolClient } from "../tools/toolClient";
export declare function createVisionDescribeSkill(toolClient: ToolClient): Skill<VisionDescribeInput, VisionDescribeOutput>;
//# sourceMappingURL=vision_describe.d.ts.map