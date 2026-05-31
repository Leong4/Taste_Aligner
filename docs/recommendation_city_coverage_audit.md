# Recommendation City Coverage Audit

## 1 Current Recommendation Query Logic

### 1.1 `/score` 候选集如何拉取
- 入口：`services/recommendation/main.py` 的 `score_endpoint`（`main.py:135-417`）。
- Stage 1 调用：`recall_candidates(city, normalized_tags, user_id)`（`main.py:242-247`）。
- Stage 2 调用：`rerank_candidates(recall_results, user_id, user_city, user_tags)`（`main.py:261-266`）。

### 1.2 city 在查询中的角色
- `city` 是硬过滤条件（hard filter），不是 soft boost：
  - `recall_candidates` 内部先 `city_lower = city.lower().strip()`。
  - 只取 `city_items = get_items_by_city(city_lower)`（`recall.py:75-77`）。
  - `get_items_by_city` SQL：`SELECT * FROM items WHERE LOWER(city)=LOWER(?)`（`db.py:323-326`）。
- CZ：来自同城 `city_items`（`recall.py:92-124`）。
- EZ：同城 `city_items` 且 `excellence >= threshold`（`recall.py:130-147`）。
- 结论：如果该 city 在 `items` 表无行，CZ/EZ 候选都为 0。

### 1.3 tags/type 在候选阶段的作用
- `tags` 不是硬过滤：仅用于 CZ 的 `tag_overlap` 标注与 rerank 打分（`recall.py:110-123`, `rerank.py:64-90`）。
- `type` 不参与 recommendation 候选过滤：
  - `/score` 请求模型中无 item type 过滤参数（`main.py:76-90`）。
  - `memory_pool` 仅记录/回传，不参与 recall/rerank 过滤（仅出现于 `main.py:85,223,233,330,387`）。

### 1.4 candidate 来源表与 SQL
- 运行时主路径来源表是 `items`，不是 `reco_items`：
  - `db.py:get_items_by_city` 直接查 `items`（`db.py:306-352`）。
  - `recall.py` 只调用 `get_items_by_city`（`recall.py:77`）。
- `reco_items` 在 recommendation 主路径中无读取调用。

## 2 reco.db Coverage

以下为本次只读 SQL 审计（本地 `services/recommendation/data/reco.db`）。

### 2.1 表覆盖概览
SQL:
```sql
SELECT 'items' AS tbl, COUNT(*) AS total_rows, COUNT(DISTINCT lower(city)) AS cities FROM items
UNION ALL
SELECT 'reco_items' AS tbl, COUNT(*) AS total_rows, COUNT(DISTINCT lower(city)) AS cities FROM reco_items;
```
结果摘要：
- `items`: 37 rows, 3 cities
- `reco_items`: 1300 rows, 26 cities

### 2.2 `items`（运行时实际使用）城市
SQL:
```sql
SELECT lower(city) AS city, COUNT(*) AS cnt
FROM items
GROUP BY lower(city)
ORDER BY cnt DESC, city ASC;
```
结果：
- tokyo: 15
- milan: 11
- paris: 11

### 2.3 `reco_items`（当前主路径未使用）城市
SQL:
```sql
SELECT lower(city) AS city, COUNT(*) AS cnt
FROM reco_items
GROUP BY lower(city)
ORDER BY cnt DESC, city ASC;
```
结果摘要：
- 共 26 个城市，包含 `barcelona`, `guangzhou`, `tokyo`, `london`, `berlin` 等。

### 2.4 type/category 覆盖（`reco_items`）
SQL:
```sql
SELECT lower(type) AS type, COUNT(*) AS cnt
FROM reco_items
GROUP BY lower(type)
ORDER BY cnt DESC, type ASC;
```
结果：
- food: 563
- culture: 465
- walk: 272

### 2.5 Tokyo / Barcelona / Guangzhou 候选数量
SQL:
```sql
WITH q(city) AS (VALUES ('tokyo'),('barcelona'),('guangzhou'))
SELECT q.city,
       COALESCE(COUNT(i.id),0) AS cz_candidates,
       COALESCE(SUM(CASE WHEN i.excellence >= 0.8 THEN 1 ELSE 0 END),0) AS ez_candidates_est
FROM q
LEFT JOIN items i ON lower(i.city)=q.city
GROUP BY q.city
ORDER BY q.city;
```
结果：
- tokyo: cz=15, ez_est=13
- barcelona: cz=0, ez_est=0
- guangzhou: cz=0, ez_est=0

补充（`reco_items` 中这三城）：
- tokyo: 49
- barcelona: 50
- guangzhou: 50

## 3 Whether New reco.db Rows Are Actually Used

### 3.1 recommendation 是否读取 reco.db 当前内容
- 读取，但仅读取 `items` 表当前内容（每次请求实时查询）。
- 证据：`get_items_by_city` 每次新建 sqlite 连接并执行 SQL（`db.py:318-327`）。

### 3.2 是否有缓存/预处理/hardcoded seed
- 无候选缓存或预物化 candidate 集。
- 有 `item_embeddings` 缓存，但只用于 rerank 的 embedding，不影响城市候选可见性（`db.py:80-173`, `rerank.py:158-177`）。
- 无硬编码 city seed 用于 recommendation 召回。

### 3.3 手工新增城市数据后的可见性
- 若新增到 `items` 表：下次请求即可可见（无需重启，因每次实时 SQL）。
- 若新增到 `reco_items` 表：当前主链路不可见（因为主链路不查该表）。
- 因此“数据库里有 Barcelona/Guangzhou”不等于“服务可推荐”，关键在是否写入了 `items`。

### 3.4 导入链路是否写到主路径表
- `scripts/import_data_txt.py` 创建并 upsert 到 `reco_items`（`import_data_txt.py:187-205`, `276-317`）。
- 该脚本不会把数据写到 `items`，与运行时查询表错位。

## 4 Tokyo vs Barcelona vs Guangzhou

### 4.1 Tokyo
- city detection：`extract_intent` 支持 tokyo（`agent_runtime/src/skills/extract_intent.ts:23`）。
- recommendation coverage：`items` 有 tokyo 15 条，可形成 CZ/EZ（见 2.5）。
- ranking chain：recall+rereank 正常运行，通常可返回稳定列表。
- anchors/memory：是否强取决于用户 memory，但即使 memory 弱，item 候选本身存在，体验仍可用。

### 4.2 Barcelona
- city detection：支持 barcelona（`extract_intent.ts:25`）。
- recommendation coverage：`items` 无 barcelona 行，导致 `/score` 候选 0（见 2.5）。
- 虽然 `reco_items` 有 barcelona 50 行，但主路径不读取该表（见第 3 节）。
- 结果表现：city 能识别，但 recommendation 候选空；随后 cards/explain 会变弱，anchors 也可能为空或无支撑感。

### 4.3 Guangzhou
- city detection：`extract_intent` 不含 guangzhou（仅 8 城硬编码），会在上游 `extract_intent` terminal `no_city_detected`（`extract_intent.ts:19-28`, `170-178`）。
- recommendation coverage：即使 `reco_items` 有 guangzhou 50 行，当前 recommendation 主路径仍查不到（items 无该城）。
- 结论：Guangzhou 是“双重阻断”
  - 阻断 1：上游 city detection 未识别，pipeline 提前终止。
  - 阻断 2：即便绕过上游，recommendation 主路径也不读 `reco_items`。

## 5 Effective Supported Cities

以下分为“数据库存在”“服务可查”“系统可稳定推荐”。

### A. Stable supported
- **系统级（`/run` 端到端）**：`tokyo`
  - 原因：同时满足 city detection 支持 + `items` 有候选。

### B. Data exists but weakly supported
- `barcelona`, `guangzhou`（以及 `reco_items` 内其它 20+ 城）
  - 数据在 `reco_items` 存在；但 recommendation 主路径不查该表。
  - `barcelona` 额外特点：city detection 支持，但候选依旧 0。
  - `guangzhou` 额外特点：city detection 也不支持，直接早停。

### C. Not effectively supported
- 对 `/run` 文本 query 来说，凡不在 `extract_intent` 城市词表中的城市都不可有效支持。
- 当前 `extract_intent` 仅 8 城：`london, kyoto, osaka, tokyo, madrid, barcelona, munich, berlin`。

## Root Cause Analysis

为什么“Tokyo 稳定，而 Barcelona/Guangzhou 不稳定或不可用”：

1. **运行时查询表与新增数据表错位**
- recommendation 运行时查 `items`；导入/扩容主要写 `reco_items`。
- 造成“数据库看起来有城市，但服务查不到候选”。

2. **city 是硬过滤，不是软信号**
- recall 城市过滤是硬条件，`items` 无该城即 0 候选，无法靠 tags/type 补救。

3. **上游 city detection 覆盖窄（系统级问题）**
- 即使 recommendation 数据层补齐，`/run` 仍可能在 `extract_intent` 因 `no_city_detected` 早停（如 guangzhou）。

## Suggested Fix Direction

仅给方向，不改代码：

1. **统一数据主表合同**
- 明确 recommendation 主路径应读取哪张表（`items` 或 `reco_items`），避免“导入到 A、查询在 B”。

2. **建立城市覆盖一致性检查**
- 启动或 CI 校验：
  - `extract_intent` 可识别城市集合
  - recommendation 查询表城市集合
  - 两者差集告警

3. **补全 `items` 的城市覆盖或切换查询表**
- 若继续使用 `items`，需要将 Barcelona/Guangzhou 等城市数据同步进 `items`。
- 若改用 `reco_items`，需同步完成字段映射（`id/item_id`, tags, embedding 需求等）。

4. **明确“数据库存在 vs 服务可查 vs 系统可推荐”监控口径**
- 监控中分别输出：
  - query city 识别成功率
  - recall 城市命中候选数（按城市）
  - 最终非空推荐率（按城市）
