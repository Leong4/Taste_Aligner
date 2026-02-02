# Recommendation Service v1.1 - 设计决策说明（中文）

## 总览

本文档解释 Recommendation Service v1.1 的核心设计决策，以及为什么这些改进能提升系统稳定性、可维护性和可扩展性。

---

## 1. 为什么 SQLite 统一持久化？

### 问题背景

**v1.0 的问题：**
- 推荐数据集硬编码在 Python 文件中（`dataset.py`）
- 内存服务虽然用 SQLite，但推荐服务不一致
- 修改数据需要改代码、重启服务
- 测试数据和生产数据混在一起

### SQLite 统一的优势

#### 1.1 一致性和可维护性

```
统一前：
Memory:      SQLite (memory.db)
Recommendation: Python dict (dataset.py)
```

```
统一后：
Memory:      SQLite (memory.db)
Recommendation: SQLite (reco.db)
```

**好处：**
- **统一的数据访问模式**：所有服务都用相同的持久化方案
- **统一的备份策略**：一个脚本备份所有 SQLite 数据库
- **统一的迁移工具**：数据库版本管理工具可复用

#### 1.2 数据独立于代码

**v1.0 (硬编码):**
```python
# dataset.py
SEED_ITEMS = [
    {"item_id": "tokyo_001", ...},  # 修改需要改代码
]
```

**v1.1 (SQLite):**
```python
# db.py
def get_all_items():
    return query_database()  # 数据在数据库中
```

**好处：**
- **动态更新**：添加新城市、新项目不需要重启服务
- **A/B 测试**：可以有多个数据库版本（reco_v1.db, reco_v2.db）
- **环境隔离**：开发、测试、生产用不同数据库

#### 1.3 可扩展性和性能

**索引优化：**
```sql
CREATE INDEX idx_city ON items(city);
CREATE INDEX idx_excellence ON items(excellence);
```

**查询效率：**
- v1.0: O(n) 全表扫描 Python 列表
- v1.1: O(log n) 使用索引的 SQL 查询

**未来扩展：**
- 可以轻松迁移到 PostgreSQL（只需改连接层）
- 支持分布式查询（读写分离）
- 支持数据分析（直接用 SQL 工具）

#### 1.4 幂等性和可重复性

**种子脚本：**
```python
def seed_dataset():
    # INSERT OR REPLACE - 幂等操作
    cursor.execute("INSERT OR REPLACE INTO items ...")
```

**好处：**
- **可重复运行**：`python3 scripts/seed_reco_db.py` 多次运行安全
- **版本控制友好**：数据变更可以追踪（数据库 schema 变更脚本）
- **回滚容易**：数据库快照和恢复

---

## 2. 为什么 CZ 必须只有同城项目？

### 问题：Cross-city "Smell"

**v1.0 的问题：**

用户在东京，查询 `city=tokyo, tags=[ramen]`

**不好的结果（v1.0）：**
```json
"cz_ranked": [
    {"id": "tokyo_ramen_001", "city": "tokyo", "score_CZ": 2.1},  // 好
    {"id": "paris_ramen_001", "city": "paris", "score_CZ": 1.8},  // 不好！
]
```

**为什么这是问题？**

1. **语义不一致**
   - CZ = "Comfort Zone" = 安全、熟悉、高命中率
   - 巴黎的拉面店对在东京的用户不是"comfort zone"

2. **物理不可达**
   - 用户此刻在东京，推荐巴黎的餐厅没有意义
   - 即使标签匹配（都是 ramen），地理位置不匹配

3. **破坏 Agent 信任**
   - Planner Agent 期望 CZ 是"立即可用"的推荐
   - 跨城市推荐需要额外的上下文判断（用户会去巴黎吗？）

### v1.1 解决方案：CZ City-Only

**召回阶段分离：**
```python
# CZ candidates: ONLY same city
cz_candidates = get_items_by_city(request_city)

# EZ candidates: Global (any city)
ez_candidates = get_items_by_excellence_threshold(0.8)
```

**效果：**
```json
"cz_ranked": [
    {"id": "tokyo_ramen_001", "city": "tokyo"},  // ✓
    {"id": "tokyo_ramen_002", "city": "tokyo"},  // ✓
    {"id": "tokyo_sushi_001", "city": "tokyo"},  // ✓
]

"ez_ranked": [
    {"id": "paris_sushi_001", "city": "paris"},  // 探索，可以跨城市
    {"id": "milan_pasta_001", "city": "milan"}   // 探索，可以跨城市
]
```

**验证：**
```bash
# 日志会检查 CZ 是否泄漏
if len(cz_cities) > 1:
    logger.error(f"CZ LEAK: Found {cz_cities}")
```

**优势：**
- **语义清晰**：CZ = 本地可达、EZ = 全局探索
- **Agent 友好**：Planner 不需要额外过滤 CZ
- **性能优化**：CZ 查询只扫描一个城市的数据

---

## 3. 为什么 EZ 要强调 taste_distance？

### 问题：EZ 不是"1 - similarity"

**错误理解（v1.0）：**
```python
# 错误！
score_EZ = 1 - similarity
```

这会导致：
- 完全不相关的项目得分最高
- 用户看到毫无道理的推荐
- 探索变成"随机"而非"有理由的探索"

### 正确理解：EZ = Excellence + Distance

**v1.1 公式：**
```python
taste_similarity = tag_similarity(item, user)
taste_similarity_capped = min(taste_similarity, SIM_CAP)  # 0.7
taste_distance = 1 - taste_similarity_capped

score_EZ = μ * global_excellence + ν * taste_distance
```

**为什么需要 SIM_CAP？**

**场景 1：没有 cap**
```
Item A: similarity=0.9, excellence=0.95
  → distance=0.1
  → score_EZ = 1.0 * 0.95 + 0.8 * 0.1 = 1.03

Item B: similarity=0.1, excellence=0.85
  → distance=0.9
  → score_EZ = 1.0 * 0.85 + 0.8 * 0.9 = 1.57 (胜出)
```

**问题：** Item B 虽然 excellence 低，但因为完全不相关（similarity=0.1）反而得分高。

**场景 2：有 cap (0.7)**
```
Item A: similarity=0.9 → capped to 0.7
  → distance=0.3
  → score_EZ = 1.0 * 0.95 + 0.8 * 0.3 = 1.19 (胜出)

Item B: similarity=0.1
  → distance=0.9
  → score_EZ = 1.0 * 0.85 + 0.8 * 0.9 = 1.57
```

**等等，Item B 还是胜出？**

**正确！** 因为 distance=0.9 太远了，v1.1 会**丢弃**：

```python
if taste_distance > EZ_TASTE_DISTANCE_MAX (0.7):
    return None  # 太远，不要
```

**最终效果：**
- Item A: distance=0.3, excellence=0.95 → 保留
- Item B: distance=0.9 → 丢弃（太远）

**设计哲学：**

> **探索不是随机，而是有理由的新颖性。**

EZ 应该推荐：
- 高质量（excellence 高）
- 适度不同（distance 在合理范围内）
- 可解释（"这是世界级的，虽然与你平时口味略有不同"）

**不应该推荐：**
- 低质量但完全不相关的项目

---

## 4. 为什么 memory_influence 必须基于项目？

### 问题：常量 memory_influence 没有意义

**v1.0 的问题：**
```python
# 所有项目的 memory_influence 都相同
memory_influence = 1.0  # 常量
```

**结果：**
```json
"cz_ranked": [
    {"id": "item_A", "memory_influence": 1.0},
    {"id": "item_B", "memory_influence": 1.0},  // 完全相同！
    {"id": "item_C", "memory_influence": 1.0}
]
```

**为什么这是问题？**

1. **失去排序意义**
   - memory_influence 是 CZ 公式的一部分
   - 如果都是常量，就不影响排序
   - 等于这个因子不存在

2. **无法体现记忆相关性**
   - 用户过去喜欢的是寿司
   - 推荐拉面和推荐寿司应该有不同的 memory_influence
   - 但 v1.0 两者都是 1.0

3. **不可解释**
   - "为什么推荐这个？" → "因为你的记忆"
   - "哪些记忆？" → 无法回答

### v1.1 解决方案：Item-to-Memory Cosine

**流程：**

1. **调用 Memory Service**
   ```python
   memory_results = call_memory_service(user_id, city, tags)
   # 返回用户的 top-5 记忆（带 embedding）
   ```

2. **计算 Item-to-Memory 相似度**
   ```python
   for memory in top_memories:
       sim = cosine_similarity(item.embedding, memory.embedding)

   max_sim = max(similarities)
   memory_influence = scale(max_sim)  # 映射到 [0, 1.5]
   ```

3. **返回可解释信息**
   ```json
   "memory_influence_detail": {
       "score": 1.35,
       "method": "max_item_to_memory_cosine",
       "anchor_memory_ids": ["mem_001", "mem_014"],
       "top_similarities": [
           {"memory_id": "mem_001", "similarity": 0.89},
           {"memory_id": "mem_014", "similarity": 0.76}
       ]
   }
   ```

**效果：**
```json
"cz_ranked": [
    {
        "id": "tokyo_sushi_001",
        "memory_influence": 1.42,  // 用户经常吃寿司
        "anchor_memory_ids": ["mem_sushi_1", "mem_sushi_2"]
    },
    {
        "id": "tokyo_ramen_001",
        "memory_influence": 0.87,  // 偶尔吃拉面
        "anchor_memory_ids": ["mem_ramen_1"]
    },
    {
        "id": "tokyo_coffee_001",
        "memory_influence": 1.01,  // 没有相关记忆，fallback
        "method": "fallback_no_memories"
    }
]
```

**优势：**

1. **有意义的排序差异**
   - 不同项目有不同的 memory_influence
   - 排序真正反映用户历史偏好

2. **完全可解释**
   - "为什么推荐寿司？" → "因为你之前吃过寿司（mem_sushi_1, mem_sushi_2）"
   - Agent 可以生成自然语言解释

3. **可调试**
   - `method` 字段显示使用了什么方法（cosine / fallback）
   - `top_similarities` 显示最相关的记忆

4. **降级友好**
   - Memory Service 不可用？→ fallback to 1.0
   - 没有记忆？→ fallback to 1.0
   - 不影响服务稳定性

---

## 5. 如何扩展数据集（添加城市/项目）？

### 方法 1：修改种子脚本（开发环境）

**编辑 `scripts/seed_reco_db.py`：**

```python
MVP_DATASET = [
    # 现有的 Tokyo, Paris, Milan 数据...

    # 添加新城市：London
    {
        "id": "london_fish_001",
        "city": "london",
        "title": "Poppies Fish & Chips",
        "tags": ["fish_chips", "british", "casual", "traditional"],
        "excellence": 0.84,
        "description": "Famous fish and chips in Spitalfields"
    },
    # ... 更多 London 项目
]
```

**重新运行：**
```bash
python3 scripts/seed_reco_db.py
```

**优点：** 简单，适合初始开发
**缺点：** 需要改代码

### 方法 2：直接操作数据库（生产环境）

**SQL 插入：**
```sql
INSERT INTO items (
    id, city, title, tags_json, excellence,
    embedding_json, description
) VALUES (
    'london_fish_001',
    'london',
    'Poppies Fish & Chips',
    '["fish_chips", "british", "casual", "traditional"]',
    0.84,
    '[0.1, 0.2, ..., 0.5]',  -- 512-dim embedding
    'Famous fish and chips'
);
```

**优点：** 不需要改代码，不需要重启
**缺点：** 需要手动生成 embedding

### 方法 3：API 管理接口（v2 扩展）

**未来可以添加管理 API：**

```python
@app.post("/admin/items")
async def add_item(item: ItemCreateRequest):
    # 1. 验证权限
    # 2. 调用 Embedding Service 生成 embedding
    # 3. 插入数据库
    return {"ok": True, "item_id": item.id}
```

**使用：**
```bash
curl -X POST http://localhost:5005/admin/items \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "id": "london_fish_001",
    "city": "london",
    "title": "Poppies Fish & Chips",
    "tags": ["fish_chips", "british"],
    "excellence": 0.84
  }'
```

**优点：**
- RESTful API，易于集成
- 自动生成 embedding（调用 Embedding Service）
- 权限控制

### 方法 4：批量导入 CSV/JSON

**创建 `scripts/import_items.py`：**

```python
import csv
import json

def import_from_csv(csv_path):
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            # 生成 embedding
            embedding = generate_embedding(row['title'] + ' ' + row['tags'])

            # 插入数据库
            insert_item(
                id=row['id'],
                city=row['city'],
                title=row['title'],
                tags=json.loads(row['tags_json']),
                excellence=float(row['excellence']),
                embedding=embedding
            )

if __name__ == "__main__":
    import_from_csv("new_items.csv")
```

**CSV 格式：**
```csv
id,city,title,tags_json,excellence,description
london_fish_001,london,Poppies Fish & Chips,"[""fish_chips"",""british""]",0.84,Famous fish and chips
london_pub_001,london,The Churchill Arms,"[""pub"",""drinks""]",0.81,Historic pub
```

**运行：**
```bash
python3 scripts/import_items.py
```

**优点：**
- 批量操作效率高
- 易于版本控制（CSV/JSON 在 git 中）
- 可以从电子表格导出

---

## 6. 总结：v1.1 设计价值

### 稳定性提升

| 维度 | v1.0 | v1.1 |
|------|------|------|
| 数据持久化 | ❌ 硬编码 Python | ✅ SQLite（一致性） |
| CZ 语义 | ⚠️ 可能跨城市 | ✅ 严格同城 |
| EZ 空集 | ❌ tags=[] → 空 | ✅ Excellence 兜底 |
| memory_influence | ❌ 常量 | ✅ 基于项目 |
| 降级策略 | ❌ 无 | ✅ Fallback 机制 |

### 可维护性提升

- **数据与代码分离**：修改数据不需要改代码
- **统一持久化**：所有服务用 SQLite，工具链统一
- **幂等种子脚本**：可重复运行，安全可靠
- **完整日志**：每个阶段有详细日志，易于调试

### 可扩展性提升

- **索引优化**：SQL 查询比 Python 列表快
- **易于迁移**：SQLite → PostgreSQL 只需改连接层
- **多版本数据**：A/B 测试用不同数据库
- **API 化路径**：为管理接口打好基础

### Agent 友好性

- **语义清晰**：CZ/EZ 分离明确
- **完全可解释**：每个分数都有组件分解
- **可控策略**：intent + memory_confidence 控制混合比例
- **结构化输出**：Planner 可直接消费

---

## 7. 后续优化方向

### v1.2 可能改进

1. **向量数据库**
   - 当前：SQLite + JSON embedding
   - 优化：Qdrant / Milvus（向量专用数据库）
   - 优势：更快的向量相似度搜索

2. **缓存层**
   - 当前：每次查询都访问数据库
   - 优化：Redis 缓存热门项目
   - 优势：降低数据库压力

3. **实时更新**
   - 当前：静态数据集
   - 优化：WebSocket 推送新项目
   - 优势：数据实时性

4. **多模态 Embedding**
   - 当前：只有文本 embedding
   - 优化：图片 + 文本联合 embedding
   - 优势：更丰富的语义理解

---

**结论：** v1.1 的 SQLite 统一、CZ 同城约束、EZ 距离强调、memory_influence 项目化，以及可控混合策略，共同构建了一个**稳定、可解释、可扩展**的推荐系统基础架构。这为后续迭代和 Agent 集成提供了坚实的工程基础。

---

_Last updated: 2026-01-31_
_Recommendation Service v1.1 - Taste Aligner Project_
