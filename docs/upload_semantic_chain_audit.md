# Upload Semantic Chain Audit

## 1 Vision Backend

### 1.1 当前实际 backend
- 代码入口: `services/vision/main.py` -> `get_backend()`（`services/vision/backends.py`）。
- backend 选择逻辑:
  - `VISION_BACKEND=rule_v0` -> 规则关键词后端
  - `VISION_BACKEND=clip_v1` -> CLIP 后端
- 运行证据（当前日志）:
  - `logs/vision.log` 显示 `Backend selected: rule_v0 (no model)`，并有 `describe OK: backend=rule_v0 ...`。
- 结论:
  - 当前你本地最近一次运行实际是 `rule_v0`。
  - 但代码默认环境变量回退值是 `clip_v1`（`backends.py`），是否生效取决于启动脚本/环境。

### 1.2 vision.describe 输出 schema
- Vision Service `/describe`（`services/vision/main.py`）返回字段:
  - `type` (`food|scenery|unknown`)
  - `cues` (list)
  - `tags` (list)
  - `raw.scores`（分数列表）
  - `backend/model_id/device/meta`
- Agent skill `vision_describe`（`agent_runtime/src/skills/vision_describe.ts`）输出字段:
  - `vision_features`（由 `cues + tags` 合并、去重、排序）
  - `vision_type`（从 service 的 `type` 映射）
  - `used/fallback_used/fallback_reason/tags_count/...`
- 注意:
  - skill 输出/trace里 **没有** `confidence` 字段（只有 `tags_count` 和服务原始 `raw.scores` 未透传）。

### 1.3 vision_type=unknown 的条件
- 主要来自 `_classify_type(tags)`（`services/vision/backends.py`）:
  - `food_count > scenery_count` -> `food`
  - `scenery_count > food_count` -> `scenery`
  - 否则 -> `unknown`（包含两者都 0 或计数相等）。
- 在 `rule_v0` 下，标签来源是对 `image_url/image_base64` **字符串做关键词匹配**，不是图像语义模型；会出现不稳定命中，导致 `unknown`。

### 1.4 fallback 逻辑
- `vision_describe.ts` fallback:
  - 无图: `fallback_reason=no_image`
  - 工具失败: `tool_error`
  - 输出结构异常: `invalid_output`
- fallback 输出为 `vision_features=[]`，且通常不写 `vision_type`。
- 因此 `VISION_TYPE=unknown` 通常是“成功返回 unknown”，不是 skill fallback 直接写 unknown。

## 2 Vision → TES Builder Data Flow

### 2.1 字段传递链
- 图定义（`agent_runtime/src/core/graph_definition.ts`）:
  - `vision_describe` 输入: `input.image_url`, `input.image_base64`
  - `tes_builder` 输入:
    - `vision_features: vision_describe.vision_features`
    - `vision_type: vision_describe.vision_type`
    - `anchor_tags: memory_weight_adjust.anchor_tags`
    - `normalized_tags: tag_normalize.normalized_tags`

### 2.2 tes_builder 实际使用
- `tes_builder.ts` 内:
  - `visionFeatures = normalizeAnchorTags(input.vision_features)`
  - `tagsForTes = anchor_tags || normalized_tags`
  - embedding 调用发送 `{ tags: tagsForTes, vision_features: visionFeatures }`
- 结论:
  - Vision 输出确实接入到了 TES embedding。
  - 但 **Vision 不参与 tag_expand/tag_normalize**（见下一节），所以“最终 memory tags”未必包含 vision cues。

## 3 Tag Generation

### 3.1 tags 来源
- 主来源是文本链:
  - `extract_intent`（关键词规则） -> seed tags
  - `tag_expand`（LLM 生成 hard/soft）
  - `tag_normalize`（ontology 归一）
- Vision cues 不进入 `tag_expand/tag_normalize` 输入（图顺序里 vision 在后）。

### 3.2 tags 为空的典型条件
- `extract_intent` 命不中关键词（例如 `paella` 不在 FOOD/CULTURE 关键词集合）导致 seed 为空。
- `tag_expand` fallback:
  - `adapter_error`
  - `invalid_output`
  - `token_budget_exceeded`
  - `empty_generation`
  - `all_filtered`
- fallback 时 `tags_final = seedTags`，若 seed 本来为空则最终为空。

### 3.3 关键结构性问题
- 代码证据: `graph_definition.ts` 中 `tag_expand` 在 `vision_describe` 之前执行。
- 结果:
  - 即使 `vision.describe` 成功，也不能补救 `tag_expand` 的空标签。
- 另外一个强影响点:
  - `createLLMAdapterFromEnv` 默认 provider 是 `mock`（未启用真实 LLM 时）。
  - `tag_expand` 需要 `hard_expansions/soft_expansions` schema；mock 返回并非该 schema，会触发 `invalid_output` fallback，导致 tags 很容易为空。

## 4 Sentiment Chain

### 4.1 文件与实现
- 仓库中没有 `agent_runtime/src/skills/sentiment_analyze.ts`。
- sentiment 实际在 `tes_builder.ts` 的 `extractSentimentLLM()` 中完成。

### 4.2 provider
- 由 `createLLMAdapterFromEnv()` 决定:
  - 默认 `mock`
  - `LLM_PROVIDER=openai_compat` 时走 OpenAI-compatible
- 当前日志证据（`logs/agent_runtime.log`）显示最近实例为 `openai_compat/gpt-4o-mini`。

### 4.3 fallback 条件与取值
- `extractSentimentLLM` fallback 到 0 的条件:
  - 无 adapter 或 caption 为空
  - LLM 调用异常
  - 返回字段不是有限数值
- 数值规则:
  - `clampSentiment`: clamp 到 `[-1, 1]`，再 `toFixed(4)`。
  - 所以 `sentiment=1.0` 是合法结果（模型给到高正向或超过 1 被 clamp）。

## 5 Memory Write Conditions

### 5.1 触发条件
- `tes_builder` 只有在 embedding 成功路径才会尝试写 memory。
- 前置条件:
  - `tagsForTes` 与 `visionFeatures` 不能同时为空，否则 `fallback_reason=no_tags` 并直接返回。
  - `embedding.tes_build` 必须成功且向量校验通过（否则 `tool_error/invalid_output/invalid_vector`）。
- 只有上述通过后，且 `hasUploadImageSignal(context)=true`，才执行 `writeMemoryRecord`。

### 5.2 不写入 memory 的原因
- `tes_builder` fallback（`no_tags|tool_error|invalid_output|invalid_vector`）直接导致不写入。
- 即使进入写入分支，也可能实际失败:
  - `writeMemoryRecord` 是 fire-and-forget；trace 固定写 `memory_write_status="queued"`，不等待成功结果。
  - 失败仅打 warning，不回传到前端状态。
- 真实日志证据:
  - `logs/memory.log` 有 `Validation error: invalid_data_url`（`POST /write` 422）。
  - `logs/agent_runtime.log` 有 `[tes_builder] memory.write HTTP 422`。

### 5.3 tags 持久化与 vision 的脱节
- `tes_builder` 写 memory 时:
  - `raw_tags/normalized_tags` 来自 `tagsForTes`（anchor/normalized 文本链）
  - **不包含 `visionFeatures`**
- 这会导致:
  - vision 成功、embedding 成功，但 memory 里的 tags 仍可能为空。

## 6 Image Asset Split

### 6.1 上传端字段
- `ImportPage.tsx`:
  - 原图 `imagePreview`（Data URL）
  - 生成压缩 `visionInputDataUrl`（webp, max width 1024）
  - 调 `/run` 发送:
    - `image_base64 = visionInputDataUrl`
    - `image_original_base64 = imagePreview`

### 6.2 server 到 skill
- `server.ts`:
  - 接收并透传 `image_base64` 与 `image_original_base64`
  - 若缺 `image_base64` 但有 original，会回退 `image_base64=original`（兼容路径）
- `vision_describe` 实际吃的是 `input.image_base64`。

### 6.3 memory 资产分流
- `tes_builder` 写 memory body:
  - `image_base64` 填 original
  - `image_vision_input_base64` 填压缩版（若与 original 不同）
- `services/memory/main.py::_save_image_assets`:
  - 保存 `original`
  - 生成 `preview/thumb/vision_input`
  - 若提供 `image_vision_input_base64`，会覆盖 `vision_input.webp`

### 6.4 是否仍可能走 original 进 vision
- 会。若调用方只传 `image_original_base64`，`server.ts` 会把它回填到 `image_base64`，vision 就吃原图。

### 6.5 超尺寸失败风险
- 当前没有统一字节级 hard limit 校验（agent/gateway/vision）。
- UI 路径已做尺寸压缩，风险降低；非 UI 调用或兼容回退路径仍可能把大原图直接送到 vision。

## Root Cause Hypothesis

1. **Vision backend 本身不稳定（rule_v0）**
- 当前实际 backend 常为 `rule_v0`，是对 URL/base64 字符串做关键词匹配，不是图像语义理解。
- 导致 `vision_type` 和 cues 受编码文本偶然命中影响，出现 `unknown` 或漂移。

2. **Tag 链与 Vision 链断开**
- `tag_expand/tag_normalize` 完全先于 `vision_describe` 执行。
- vision 成功并不会补充 `normalized_tags`。
- 再叠加 LLM fallback（尤其 mock schema 不匹配），会出现“上传成功但 tags 为空”。

3. **Memory 写入可见性与成功语义不一致**
- `memory_write_status=queued` 只是“已发起”，不是“已落库”。
- 写入失败（422/timeout）不会回传失败态，造成“看起来上传成功，但 memory 没写入”。

## Suggested Fix Direction

1. Vision 语义层
- 默认 backend 切到真实图像语义（clip_v1 或云视觉），避免 rule_v0 的 base64 关键词噪声。
- 若保留 rule_v0，仅作降级路径，并在 trace 标注低置信后端。

2. Tag 融合层
- 让 vision cues 进入 tag 归一链（至少在 memory 持久化层融合 `vision_features`）。
- 避免仅用文本链 `tagsForTes` 写 `raw_tags/normalized_tags`。

3. 写入可靠性层
- 把 memory.write 从 fire-and-forget 改为可观测结果（成功/失败）并回传到 trace/UI。
- 明确区分 `queued` 与 `persisted_ok`。

4. 输入合同层
- 统一并严格校验 `image_base64` 格式（data URL vs raw base64）并在入站做规范化转换。
- 防止 `invalid_data_url` 422 在上传后期才暴露。

5. UI 读数层
- Import 结果里不要读不存在的 `decision_trace.vision_describe.cues`，应读 `vision_features` 或后端显式透出的 cues。
