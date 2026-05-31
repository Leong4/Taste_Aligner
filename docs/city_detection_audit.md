# City Detection Audit

## 1 Current City Detection Logic

### 1.1 识别方式
- 城市识别在 `agent_runtime/src/skills/extract_intent.ts` 的 `detectCity(text)` 中完成（`CITY_RULES` + 正则匹配）。
- 规则是纯关键词/正则，不调用 LLM、NER、外部服务或数据库。
- 关键代码：
  - `CITY_RULES` 定义：`agent_runtime/src/skills/extract_intent.ts:19-28`
  - 匹配函数 `detectCity`：`agent_runtime/src/skills/extract_intent.ts:42-49`
  - 执行入口 `execute`：`agent_runtime/src/skills/extract_intent.ts:127-137`

### 1.2 实际运行链路
- Orchestrator 注册并执行的是 `extractIntentSkill`，不是旧 `IntentAgent`：
  - 注册位置：`agent_runtime/src/core/bootstrap.ts:71`
  - skill 导出：`agent_runtime/src/skills/index.ts:8`
- 图中 `extract_intent` 节点只接收 `input.text` 和 `input.user_id`：
  - `agent_runtime/src/core/graph_definition.ts:146-152`

### 1.3 大小写匹配
- 匹配大小写不敏感：
  - 正则本身使用 `/i`（如 `/\blondon\b/i`）见 `extract_intent.ts:20-27`
  - 同时 `execute` 先将文本 `toLowerCase()`（`extract_intent.ts:131`）
- 结论：`Guangzhou` / `guangzhou` / `GUANGZHOU` 在“是否大小写匹配”层面都可匹配；失败原因不在大小写。

## 2 City Vocabulary Source

### 2.1 词表来源
- 城市词表是硬编码常量 `CITY_RULES`，定义在：
  - `agent_runtime/src/skills/extract_intent.ts:19-28`
- 未发现从配置文件动态加载城市词表。
  - `agent_runtime/src/config/` 目录为空（无城市配置文件）。

### 2.2 是否来自 reco.db / memory db / config
- 未发现 `extract_intent` 读取 `reco.db`、memory db 或其它配置数据源。
- `extract_intent` 文件内只有本地常量 + 本地函数，无 DB/HTTP 调用。

## 3 reco.db Relation

### 3.1 reco.db 中城市分布（代码执行证据）
- 表：`items`, `reco_items`, `item_embeddings`
- 运行时 recommendation 实际读取 `items` 表：
  - `get_items_by_city` SQL: `SELECT * FROM items WHERE LOWER(city)=LOWER(?)`（`services/recommendation/db.py:323-326`）
  - `recall_candidates` 调用 `get_items_by_city`（`services/recommendation/recall.py:77`）
  - `/score` 调用 `recall_candidates`（`services/recommendation/main.py:243-247`）
- 当前 `items` 表 distinct city（本地查询）仅有：`tokyo`, `milan`, `paris`。
- `reco_items` 表里有大量城市（含 `guangzhou`），但运行时路径未使用该表。
  - 全仓搜索 `reco_items` 仅见脚本/文档，不在 `main.py`/`recall.py`/`db.py` 的运行时查询路径。

### 3.2 reco.db 是否参与“城市识别”
- 不参与。
- 城市识别发生在 agent runtime 的 `extract_intent`（上游）；`reco.db` 仅在 recommendation 服务召回阶段按 city 过滤 item。
- 结论：city detection 与 reco.db 是解耦关系。

## 4 Pipeline Termination Logic

### 4.1 no_city_detected 触发条件
- 在 `extract_intent` 中：
  - 若 `!city && !isUploadFlow`，返回 `terminal: true` 且 `terminalReason: "no_city_detected"`。
  - 代码：`agent_runtime/src/skills/extract_intent.ts:170-178`
- `isUploadFlow` 由图像输入信号判断（`image_url`/`image_base64`）决定：
  - `hasUploadImageSignal`：`extract_intent.ts:84-102`

### 4.2 终止发生节点
- 首次终止发生在 skill 节点 `extract_intent`（Node 1）。
- Orchestrator 接收 terminal 后停止后续节点执行，并记录错误：
  - terminal 处理：`agent_runtime/src/core/orchestrator.ts:127-137`
  - 写入 `pipeline_terminated` + `no_city_detected`：`orchestrator.ts:221-228`

### 4.3 是否存在 fallback
- 未发现以下 fallback：
  - default city
  - user profile city
  - memory city
  - recommendation db city
- 额外证据：`/run` 虽允许传 `city`（`agent_runtime/src/server.ts:112-114`），但图中 `extract_intent` 输入映射并未接入 `input.city`（`graph_definition.ts:148-151`），因此不会用于城市识别兜底。

## Supported Cities List

系统当前在主路径中可识别的城市仅来自 `CITY_RULES`（共 8 个，不足 20 个）：
1. london
2. kyoto
3. osaka
4. tokyo
5. madrid
6. barcelona
7. munich
8. berlin

来源：`agent_runtime/src/skills/extract_intent.ts:19-28`

## Root Cause Analysis

为什么 `Plan a relaxing day in Guangzhou` 会触发 `pipeline_terminated — no_city_detected`：

1. `guangzhou` 不在 `extract_intent` 的硬编码 `CITY_RULES` 中（`extract_intent.ts:19-28`）。
2. `detectCity` 只在该固定列表上做正则匹配，匹配失败即 `city=null`（`extract_intent.ts:42-49`）。
3. Query 流程下 `!city && !isUploadFlow` 会直接 terminal（`extract_intent.ts:170-178`）。
4. reco.db 城市内容不会回灌到城市识别逻辑（识别与推荐库解耦）。

补充对比：
- `barcelona` 可识别，因为它在 `CITY_RULES` 中（`extract_intent.ts:25`）。

## Suggested Fix Direction

以下为方向建议（不改代码）：

1. 将城市词表从硬编码迁移为可配置数据源（例如配置文件或专门 city catalog），避免每次新增城市都要改代码。
2. 在 `extract_intent` 增加“显式 city 输入兜底”合同（当 `input.city` 存在且合法时优先/补充使用），避免纯文本识别失败直接终止。
3. 对城市识别增加 normalization（别名、拼写变体、空格/下划线统一，如 `ho chi minh city` vs `ho_chi_minh_city`）。
4. 在 terminal 前增加可控 fallback 策略（例如 `city=unknown` + 限制型推荐）以减少硬终止，但需评估对推荐质量影响。
5. 建立“城市词表 vs reco/items 城市分布”一致性检查（CI 或启动检查），防止识别覆盖与数据覆盖长期漂移。
