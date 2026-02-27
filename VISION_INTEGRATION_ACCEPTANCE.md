# Vision Integration Acceptance Report

## Executive Summary
- Overall verdict: **FAIL**.
- 代码层面已看到 vision 主线接入：`vision.describe` gateway 路由、`vision_describe` skill、graph 在 `tes_builder` 前接入。
- 但“硬性验收”未满足：本地执行的 core smoke 与 integration smoke 均失败。
- `tests/agent_runtime_core_tests/run.js` 失败点包括：
  - `test_vision_describe.js` 全失败（`createVisionDescribeSkill is not a function`）。
  - `test_tes_builder.js` 2 个失败（payload 断言与 vision-only case 断言不一致）。
- integration 失败为真实端口不可达（`localhost:8080` 与 `localhost:8787` 未连通）。
- 因此不能判定“/run 多模态闭环已真实打通”。

## Acceptance Matrix

| Item | Requirement | Result | Evidence |
|---|---|---|---|
| A1 | gateway 注册 `vision.describe -> /describe` | PASS | `gateway/src/main/java/gateway/GatewayServer.java:148` |
| A2 | gateway 输入校验：必须 `data` + (`image_url` or `image_base64`)，非法 400 + `INVALID_TOOL_INPUT` | PASS | `GatewayServer.java:381-388`, `346-425`, `479-481` |
| A3 | integration/curl 实测 200 打通 | FAIL | `node tests/integration/vision_describe_gateway_smoke.js` 输出 `gateway unreachable` |
| B1 | vision `/health` 返回 `backend/model_id/device/warm` | PASS (代码) | `services/vision/main.py:123-134` |
| B2 | `/describe` 返回 `ok/backend/model_id/device/tags/meta` | PASS (代码) | `services/vision/main.py:96-104`, `184-199` |
| B3 | tags 为 `string[]`，数值 finite，JSON 不炸 | PASS (代码) | `services/vision/main.py:109-117`, `176-199` |
| B4 | 默认本地可跑；若依赖 open_clip 文档明确 | PASS (代码+文档) | `services/vision/backends.py:308-327`, `services/vision/requirements.txt:10-13`, `docs/LOCAL_DEV.md:246-258` |
| C1 | 有 `vision_describe` skill 并接在 `tes_builder` 前 | PASS | `agent_runtime/src/skills/vision_describe.ts:123+`, `agent_runtime/src/core/graph_definition.ts:229-260` |
| C2 | 输入来自 `/run` payload（image_url/image_base64） | PASS | `graph_definition.ts:238-239`, `agent_runtime/src/core/types.ts:133-136` |
| C3 | 无图 fallback: `vision_features=[] used=false fallback_reason=no_image` | PASS | `vision_describe.ts:152-155`, `100-121` |
| C4 | `tool_error/invalid_output` 不抛异常，走 fallback + trace | PASS | `vision_describe.ts:169-182`, `100-121` |
| D1 | `/run + image_base64` 时 `vision_describe.used=true` 且 `tes_builder` 有 `vision_features_count>0` 证据 | FAIL（未实测通过） | integration `agent_run_vision_trace_smoke.js` 失败：`/run unreachable` |
| D2 | 禁止静默不生效（vision used 但 TES 未吃到） | FAIL（未完成闭环实测） | 无法给出运行证据；仅有测试脚本断言 `tests/integration/agent_run_vision_trace_smoke.js:177-185` |
| E1 | 新增并通过 integration：`vision_describe_gateway_smoke.js` / `agent_run_vision_trace_smoke.js` | FAIL | 文件存在，但运行失败：端口不可达 |
| E2 | core 至少 1 个 vision 单测且 run.js 执行到 | FAIL | run.js 包含 `test_vision_describe.js` (`tests/agent_runtime_core_tests/run.js:395`)，但实际 9/9 fail |
| E3 | `dev_up/dev_verify --with-vision` 可用（加分） | PASS（脚本能力） | `scripts/dev_up.sh:9,210-217,283-309`, `scripts/dev_verify.sh:125-193` |

## Command Results (Executed)

### 1) Core smoke
Command:
```bash
node tests/agent_runtime_core_tests/run.js
```
Result: **FAIL**  
Key output:
- `SATELLITE FAIL: test_tes_builder.js`
- `SATELLITE FAIL: test_vision_describe.js`
- `Core results: 16 passed, 2 failed`

### 2) Gateway vision smoke
Command:
```bash
node tests/integration/vision_describe_gateway_smoke.js
```
Result: **FAIL**  
Key output:
- `FAIL: gateway unreachable for vision.describe`
- `URL: http://localhost:8080/tool/vision.describe`

### 3) Agent /run vision trace smoke
Command:
```bash
node tests/integration/agent_run_vision_trace_smoke.js
```
Result: **FAIL**  
Key output:
- `FAIL: agent_runtime /run unreachable or timeout`
- `URL: http://localhost:8787/run`

## Critical Findings

### 1) `test_vision_describe.js` 无法拿到 `createVisionDescribeSkill`
- Symptom:
  - `createVisionDescribeSkill is not a function`（9 个 case 全挂）
- Code evidence:
  - 新源码有导出：`agent_runtime/src/skills/index.ts:14`
  - 但 dist 无 vision 文件：`agent_runtime/dist/skills/` 列表无 `vision_describe.js`
  - dist barrel 也未导出 vision：`agent_runtime/dist/skills/index.js:9-34`
  - 本机缺 `ts-node`，测试回退到 dist：`node -e "require('ts-node')"` 输出 `ts-node:missing`
  - 测试加载逻辑：`tests/agent_runtime_core_tests/test_vision_describe.js:12-29`
- Impact:
  - 验收环境容易“以旧 dist 运行”，造成假失败或漂移。

### 2) `test_tes_builder.js` 与当前 skill 契约不一致
- Symptom (from run output):
  - happy path 断言 `result.output.normalized === true` 失败
  - vision-only case 断言 “tool should have been called” 失败
- Evidence:
  - 测试仍期待顶层 payload：`tests/agent_runtime_core_tests/test_tes_builder.js:84-88`
  - 当前 skill 实际发送 `input: { data: { ... } }`：`agent_runtime/src/skills/tes_builder.ts:258-268`
  - 这导致 stub 断言与实际实现不一致，出现假阴性。

### 3) 真实联通证据缺失
- integration 两条关键 smoke 未通过，无法证明 D 项“vision -> TES -> /run trace”在真实端口闭环生效。

## Unfinished Items
- 未得到一次成功的真实 `/run` 证据，无法确认 `decision_trace.vision_describe.used=true` 与 `tes_builder.input_summary.vision_features_count>0` 同时成立。
- 当前核心 smoke 不通过，无法作为“可回归稳定”基线。

## Minimal Patch Suggestions (for this FAIL only)

1. **修复测试运行源一致性（最小）**
   - 方案 A（推荐）：先执行 `cd agent_runtime && npm run build`，确保 `dist/skills/vision_describe.js` 与 dist barrel 同步。
   - 方案 B：在 core tests 改为硬依赖 `ts-node-dev` 或统一走 `src`（避免 silent fallback 到旧 dist）。

2. **修复 `test_tes_builder.js` 与当前 payload 契约漂移**
   - 文件：`tests/agent_runtime_core_tests/test_tes_builder.js`
   - 把断言从 `action.input.tags / action.input.vision_features / action.input.normalize` 改为 `action.input.data.*`（与 `tes_builder.ts:258-268` 对齐）。

3. **先拉起端口再重跑 integration**
   - 使用：
     - `./scripts/dev_up.sh --with-vision`
     - `node tests/integration/vision_describe_gateway_smoke.js`
     - `node tests/integration/agent_run_vision_trace_smoke.js`
   - 必须拿到两个 PASS 行后，才能重评 D 项。

## Final Decision
- **Overall: FAIL**
- 原因：硬性验收要求“全部 PASS”，而当前 core smoke 与 integration smoke 都未达标，无法证明“主链路 /run 多模态闭环已真实打通”。
