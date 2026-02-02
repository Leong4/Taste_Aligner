# Recommendation Service v1 - 设计文档

## 概述

Recommendation Service v1 是 Taste Aligner 系统的核心推荐引擎，采用 **Agent-friendly、Explainable、Configurable** 的设计原则。

**核心特性：**
- ✅ 两阶段架构：Recall → Rerank
- ✅ CZ/EZ 分离：Comfort Zone（舒适区）vs Exploration Zone（探索区）
- ✅ 完全可解释：每个分数都有组件分解
- ✅ 显式配置：所有权重和阈值可调
- ✅ Agent 友好：结构化输出，供 Planner 消费

---

## 1. 工程边界 (Engineering Boundary)

### v1 的职责范围

Recommendation Service v1 **负责**：

1. **召回 (Recall)**
   - 基于规则的快速候选筛选
   - 避免假阴性（false negatives）
   - 输入：用户意图（city, tags）
   - 输出：候选集合

2. **重排 (Rerank)**
   - CZ 和 EZ 分数计算
   - 分数组件分解（可解释性）
   - 输入：召回候选
   - 输出：排序后的 CZ 和 EZ 列表

3. **混合策略 (Mix Policy)**
   - 基于分数差异决定 CZ:EZ 比例
   - 提供置信度评估
   - 输入：CZ 和 EZ 排序结果
   - 输出：建议的混合比例

Recommendation Service v1 **不负责**：

1. ❌ **多样性优化**（MMR、DPP 等）→ 留给 v2
2. ❌ **用户硬约束**（预算、时间、过敏）→ 由 Planner 处理
3. ❌ **最终呈现顺序**（交织逻辑）→ 由 Agent/Planner 决定
4. ❌ **实时用户反馈**（点击、跳过）→ 留给 v2 在线学习

### 为什么这样划分？

**原则：单一职责 + 模块化**

- **Recommendation Service**：专注于"找到并排序相关项目"
- **Planner Agent**：负责"满足约束 + 生成行程"
- **Memory Service**：提供"历史偏好信号"

这种划分使得每个服务都可以**独立迭代**，而不影响其他模块。

---

## 2. 为什么 Recall → Rerank 是 Agent-friendly？

### 传统推荐系统的问题

**黑盒单阶段系统：**

```
Input: user_id → [黑盒模型] → Output: [item1, item2, ...]
```

问题：
- ❌ Agent 无法理解"为什么推荐这个"
- ❌ 无法插入约束（预算、时间）
- ❌ 无法区分"熟悉的"和"新鲜的"

### Recall → Rerank 的优势

**两阶段透明系统：**

```
Input: user_intent
  ↓
[Stage 1: Recall] → 候选集合 (规则可见)
  ↓
[Stage 2: Rerank] → CZ 排序 + EZ 排序 (分数可解释)
  ↓
[Mix Policy] → 建议比例 (策略显式)
  ↓
Output: 结构化结果 → Agent/Planner 消费
```

**Agent-friendly 体现在：**

1. **可插入性 (Pluggable)**
   - Agent 可以在 Recall 后添加过滤规则
   - Agent 可以在 Rerank 后重新排序
   - Agent 可以覆盖 Mix Policy

2. **可解释性 (Explainable)**
   - 每个推荐都有明确的理由
   - CZ: "strong taste match + positive memories"
   - EZ: "exceptional quality + moderate distance"

3. **可组合性 (Composable)**
   - Recall 规则可以扩展（添加预算过滤）
   - Rerank 可以集成新信号（实时流行度）
   - Mix Policy 可以个性化（保守用户 → 更多 CZ）

---

## 3. 两阶段架构详解

### Stage 1: Recall（召回）

**目标：** 最大化召回率，避免遗漏好结果

**允许的规则（仅限以下三种）：**

1. **城市匹配**
   ```python
   if item.city == user.city:
       recall(item)
   ```

2. **标签重叠**
   ```python
   if len(item.tags ∩ user.tags) >= 1:
       recall(item)
   ```

3. **EZ 兜底（全局卓越度）**
   ```python
   if item.global_excellence >= 0.8:
       recall(item)  # 即使不匹配城市/标签
   ```

**禁止在 Recall 阶段使用：**
- ❌ 嵌入向量余弦相似度（太慢）
- ❌ 情感权重（需要 Memory 查询）
- ❌ 时间衰减（需要用户历史）

**为什么这样设计？**

- **Recall 必须快**：O(n) 线性扫描，n = 全部项目数
- **假阳性可接受**：召回太多没关系，Rerank 会过滤
- **假阴性不可接受**：召回遗漏了，后面无法挽回

### Stage 2: Rerank（重排）

**目标：** 计算精确分数，分离 CZ 和 EZ

#### CZ (Comfort Zone) 评分

**公式：**

```
score_CZ = α × tag_similarity + β × memory_influence + γ × location_relevance
```

**参数（可配置）：**
- α = 1.0（标签相似度权重，主导因子）
- β = 0.6（记忆影响权重）
- γ = 0.3（位置相关性权重）

**组件定义：**

1. **tag_similarity（标签相似度）**
   - 使用 Jaccard 相似度：`|交集| / |并集|`
   - 范围：[0, 1]
   - 高值 → 强烈匹配用户显式偏好

2. **memory_influence（记忆影响）**
   - 从 Memory Service v1.3 获取加权分数
   - 整合：时间衰减 + 情感权重 + 上下文增强
   - 范围：[0, ~1.5]
   - 高值 → 用户有积极的历史记忆

3. **location_relevance（位置相关性）**
   - 同城市：1.0
   - 文化邻近：0.8（v2 扩展）
   - 其他：0.5
   - 提供文化语境锚定

**可解释性输出：**

```json
{
  "score_CZ": 1.87,
  "components": {
    "tag_similarity": 0.92,
    "memory_influence": 1.31,
    "location_relevance": 1.0
  },
  "weights": {
    "alpha": 1.0,
    "beta": 0.6,
    "gamma": 0.3
  },
  "reason": "strong taste match + positive recent memories + same location"
}
```

#### EZ (Exploration Zone) 评分

**公式：**

```
score_EZ = μ × global_excellence + ν × taste_distance
```

**禁止的错误公式：**
```
❌ score_EZ = 1 - similarity  # 这是错误的！
```

**正确理解：**

- EZ **不是** "与 CZ 相反"
- EZ **是** "高质量 + 适度距离"

**参数（可配置）：**
- μ = 1.0（全局卓越度权重，主导）
- ν = 0.4（品味距离权重）
- taste_distance_max = 0.7（距离上限，超过则丢弃）

**组件定义：**

1. **global_excellence（全局卓越度）**
   - 预定义的项目级别质量分数
   - 例如：米其林星级、世界排名
   - 范围：[0, 1]

2. **taste_distance（品味距离）**
   - = 1 - taste_similarity
   - 必须 ≤ 0.7（否则太远，丢弃）
   - 确保探索是**合理的**，而非随机的

**可解释性输出：**

```json
{
  "score_EZ": 1.18,
  "components": {
    "global_excellence": 0.93,
    "taste_similarity": 0.62,
    "taste_distance": 0.38
  },
  "weights": {
    "mu": 1.0,
    "nu": 0.4
  },
  "why_explore": "exceptional_quality_low_overlap"
}
```

---

## 4. CZ/EZ 混合策略

### 决策逻辑

定义分数差异：

```
Δ = top_CZ_score - top_EZ_score
```

**规则：**

| 条件 | CZ:EZ 比例 | 规则名称 | 含义 |
|------|-----------|---------|------|
| Δ > T_HIGH (0.5) | 3:1 | `cz_strong` | CZ 非常强，主推熟悉项目 |
| \|Δ\| ≤ T_MID (0.2) | 2:1 | `balanced` | 平衡，适度探索 |
| Δ < -T_MID | 1:2 | `ez_attractive` | EZ 吸引力强，多推探索 |

**置信度计算：**

```python
if Δ > T_HIGH:
    confidence = min(1.0, 0.7 + (Δ - T_HIGH) * 0.3)
elif abs(Δ) <= T_MID:
    confidence = 0.5 + (T_MID - abs(Δ)) * 0.5
else:
    confidence = min(1.0, 0.7 + abs(Δ + T_MID) * 0.3)
```

**为什么需要混合策略？**

1. **避免过滤气泡 (Filter Bubble)**
   - 纯 CZ → 用户永远看不到新事物
   - 纯 EZ → 用户感到困惑，推荐不相关

2. **自适应探索**
   - 当 CZ 非常强时（用户偏好明确）→ 少量探索
   - 当 CZ 和 EZ 接近时（偏好不明确）→ 平衡推荐

3. **Agent 可覆盖**
   - Mix Policy 只是**建议**
   - Planner 可以根据用户性格调整
   - 保守用户 → 增加 CZ 比例
   - 冒险用户 → 增加 EZ 比例

---

## 5. Agent/Planner 可用字段

### 输出结构

```json
{
  "dummy": false,
  "trace_id": "t_abc123",

  "input": {
    "user_id": "u001",
    "city": "tokyo",
    "tags": ["ramen", "nightlife"],
    "normalized_tags": ["ramen", "nightlife"]
  },

  "recall": {
    "total_candidates": 11,
    "recall_rules": ["city_match", "tag_overlap"],
    "stats": {
      "city_matches": 11,
      "tag_matches": 7,
      "ez_fallback_matches": 5
    }
  },

  "mix_policy": {
    "cz": 3,
    "ez": 1,
    "rule": "cz_strong",
    "confidence": 0.7823,
    "delta": 0.6421,
    "top_cz_score": 2.1234,
    "top_ez_score": 1.4813
  },

  "cz_ranked": [
    {
      "item_id": "tokyo_001",
      "score_CZ": 2.1234,
      "components": {...},
      "reason": "strong taste match + same location",
      "item": {
        "name": "Ichiran Ramen",
        "city": "tokyo",
        "raw_tags": ["ramen", "japanese"],
        "global_excellence": 0.85
      }
    }
  ],

  "ez_ranked": [
    {
      "item_id": "tokyo_002",
      "score_EZ": 1.4813,
      "components": {...},
      "why_explore": "world_class_slightly_different",
      "item": {...}
    }
  ],

  "debug": {
    "weights": {...},
    "thresholds": {...}
  }
}
```

### Planner 可以使用的信号

#### 1. 召回阶段信息

```python
# 理解召回规则
if "city_match" in result["recall"]["recall_rules"]:
    # 所有结果都在用户所在城市
    planner.set_constraint("same_city", True)

# 检查候选数量
if result["recall"]["total_candidates"] < 5:
    # 候选太少，可能需要放宽条件
    planner.suggest_expand_search()
```

#### 2. CZ 项目信息

```python
for item in result["cz_ranked"]:
    # 获取分数组件
    tag_sim = item["components"]["tag_similarity"]
    memory_inf = item["components"]["memory_influence"]

    if tag_sim > 0.8 and memory_inf > 1.0:
        # 强烈匹配 + 积极记忆 → 高优先级
        planner.mark_high_priority(item)

    # 使用锚定记忆
    if item["anchor_memory_ids"]:
        # 可以解释："因为你之前喜欢过类似的地方"
        planner.add_explanation(item, "based_on_history")
```

#### 3. EZ 项目信息

```python
for item in result["ez_ranked"]:
    excellence = item["components"]["global_excellence"]
    taste_dist = item["components"]["taste_distance"]

    if excellence > 0.9 and taste_dist < 0.5:
        # 世界级 + 适度距离 → 值得推荐
        planner.add_exploration(item)

    # 使用探索理由
    reason = item["why_explore"]
    if reason == "exceptional_quality_low_overlap":
        planner.explain("This is world-class, slightly different from your usual taste")
```

#### 4. 混合策略信息

```python
policy = result["mix_policy"]

if policy["rule"] == "cz_strong" and policy["confidence"] > 0.8:
    # 用户偏好非常明确，主推 CZ
    planner.set_cz_ratio(0.75)
elif policy["rule"] == "balanced":
    # 平衡推荐
    planner.set_cz_ratio(0.67)
else:
    # EZ 吸引力强，多探索
    planner.set_cz_ratio(0.33)
```

---

## 6. v2 演进方向

### v1 → v2 可能的扩展

#### 1. 多样性优化 (Diversity)

**v1 限制：**
- CZ 和 EZ 内部可能都很相似
- 例如：10 个拉面店全在 CZ

**v2 改进：**

```python
# MMR (Maximal Marginal Relevance)
def rerank_with_diversity(items, λ_relevance=0.7, λ_diversity=0.3):
    selected = []
    for item in items:
        relevance = item.score_CZ
        diversity = min_similarity(item, selected)
        mmr_score = λ_relevance * relevance + λ_diversity * diversity
        selected.append(item)
    return selected
```

#### 2. 用户硬约束 (Hard Constraints)

**v1 限制：**
- 不处理预算、时间、饮食限制

**v2 改进：**

```python
# Planner 传入约束
constraints = {
    "budget": {"max": 50},
    "dietary": ["vegetarian"],
    "time_available": 120  # minutes
}

# Recall 阶段过滤
def recall_with_constraints(city, tags, constraints):
    candidates = basic_recall(city, tags)
    return [c for c in candidates if satisfies(c, constraints)]
```

#### 3. 实时信号 (Real-time Signals)

**v1 限制：**
- 仅使用静态数据（seed dataset）
- 不考虑实时流行度、排队时间

**v2 改进：**

```python
# 集成实时信号
def compute_cz_score_v2(item, user, realtime_data):
    base_score = compute_cz_score_v1(item, user)

    # 添加实时因子
    popularity_boost = realtime_data.get_popularity(item)
    wait_time_penalty = realtime_data.get_wait_time(item)

    adjusted_score = base_score * popularity_boost * wait_time_penalty
    return adjusted_score
```

#### 4. 在线学习 (Online Learning)

**v1 限制：**
- 权重是静态配置（config.py）
- 不根据用户反馈调整

**v2 改进：**

```python
# 个性化权重
def personalized_weights(user_id, feedback_history):
    if user.is_conservative():
        return {"alpha": 1.2, "beta": 0.8, "gamma": 0.4}  # 更重视熟悉度
    elif user.is_adventurous():
        return {"alpha": 0.8, "beta": 0.4, "gamma": 0.3}  # 降低熟悉度权重
    else:
        return DEFAULT_WEIGHTS
```

#### 5. 跨城市迁移 (Cross-city Transfer)

**v1 限制：**
- location_relevance 只有简单的 1.0 / 0.5
- 不理解"巴黎咖啡馆 vs 东京咖啡馆"

**v2 改进：**

```python
# 城市嵌入
city_embeddings = {
    "paris": [0.2, 0.8, ...],  # 欧洲、咖啡文化
    "tokyo": [0.9, 0.1, ...],  # 亚洲、拉面文化
}

def cultural_adjacency(city1, city2):
    cosine = dot(city_embeddings[city1], city_embeddings[city2])
    return 0.5 + 0.5 * cosine  # Range: [0.5, 1.0]
```

---

## 7. 使用指南

### 启动服务

```bash
cd services/recommendation
python3 main.py
```

服务启动在 `http://localhost:5005`

### 运行验证测试

```bash
# 自动化测试
./test_recommendation.sh

# 或手动运行
python3 test_recommendation.py
```

### cURL 示例

#### 测试 1：东京 + 拉面（强 CZ）

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "u001",
      "city": "tokyo",
      "tags": ["ramen", "nightlife", "walk"]
    }
  }' | python3 -m json.tool
```

**预期结果：**
- Recall: ~11 候选（东京所有项目 + 标签匹配）
- CZ 排名靠前：Ichiran Ramen, Afuri Ramen（标签完美匹配）
- Mix Policy: `cz_strong` (3:1)

#### 测试 2：东京 + 空标签（EZ 兜底）

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "u002",
      "city": "tokyo",
      "tags": []
    }
  }' | python3 -m json.tool
```

**预期结果：**
- Recall: 依赖 city_match + ez_global_excellence
- EZ 排名靠前：Sukiyabashi Jiro（excellence=0.98）
- Mix Policy: `ez_attractive` 或 `balanced`

#### 测试 3：巴黎 + 咖啡（文化迁移）

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "u003",
      "city": "paris",
      "tags": ["coffee", "cafe", "walk"]
    }
  }' | python3 -m json.tool
```

**预期结果：**
- CZ 排名靠前：Café de Flore（cafe 标签匹配）
- location_relevance = 1.0（同城）

#### 测试 4：米兰 + 设计（探索出现）

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "u004",
      "city": "milan",
      "tags": ["design", "art", "modern"]
    }
  }' | python3 -m json.tool
```

**预期结果：**
- CZ 和 EZ 都有强候选
- CZ: Triennale Design Museum（design 标签匹配）
- EZ: Fondazione Prada（excellence=0.92, 艺术探索）

---

## 8. 调试和调优

### 查看当前配置

```bash
curl http://localhost:5005/score \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"data": {"user_id": "test", "city": "tokyo", "tags": ["ramen"]}}' \
  | jq '.debug'
```

输出：

```json
{
  "weights": {
    "cz": {
      "alpha": 1.0,
      "beta": 0.6,
      "gamma": 0.3
    },
    "ez": {
      "mu": 1.0,
      "nu": 0.4
    }
  },
  "thresholds": {
    "mix_t_high": 0.5,
    "mix_t_mid": 0.2,
    "recall_ez_excellence": 0.8
  }
}
```

### 调整权重

编辑 `config.py`：

```python
# 增加记忆影响权重
CZ_BETA = 0.8  # 原来 0.6

# 降低探索距离权重（更保守）
EZ_NU = 0.2  # 原来 0.4

# 提高 CZ 强度阈值（更容易触发 cz_strong）
MIX_T_HIGH = 0.3  # 原来 0.5
```

重启服务后生效。

---

## 9. 文件清单

### 核心模块

| 文件 | 说明 | 行数 |
|------|------|------|
| `config.py` | 配置参数（权重、阈值） | ~90 |
| `dataset.py` | 内置种子数据（Tokyo, Paris, Milan） | ~250 |
| `recall.py` | Stage 1: 召回逻辑 | ~110 |
| `rerank.py` | Stage 2: CZ/EZ 评分 | ~320 |
| `mix_policy.py` | CZ/EZ 混合策略 | ~170 |
| `main.py` | FastAPI 服务入口 | ~270 |

### 测试和文档

| 文件 | 说明 |
|------|------|
| `test_recommendation.py` | 验证测试（4 个场景） |
| `test_recommendation.sh` | 测试运行脚本 |
| `RECOMMENDATION_V1_CN.md` | 本文档 |

---

## 10. 总结

### Recommendation v1 的核心价值

1. **透明性 (Transparency)**
   - 每个决策都有明确理由
   - Agent 可以理解和解释推荐

2. **可控性 (Controllability)**
   - 所有参数都可配置
   - Planner 可以覆盖决策

3. **模块化 (Modularity)**
   - Recall、Rerank、Mix Policy 独立
   - 可以单独优化每个阶段

4. **可扩展性 (Extensibility)**
   - v2 可以无缝集成新特性
   - 不破坏现有 Agent 集成

### 与其他服务的协作

```
┌─────────────────────────────────────────────────────────┐
│                    Planner Agent                         │
│  • 集成所有服务的输出                                      │
│  • 满足用户约束                                           │
│  • 生成最终行程                                           │
└─────────────────────────────────────────────────────────┘
           ↑           ↑           ↑           ↑
           │           │           │           │
  ┌────────┴───┐  ┌───┴────┐  ┌───┴──────┐  ┌┴───────────┐
  │ Memory v1.3│  │Ontology│  │Embedding │  │Recomm. v1  │
  │            │  │        │  │          │  │            │
  │• 时间衰减   │  │• 标签  │  │• 向量    │  │• Recall    │
  │• 情感权重   │  │  归一化│  │  相似度  │  │• Rerank    │
  │• 上下文增强 │  │        │  │          │  │• CZ/EZ分离 │
  └────────────┘  └────────┘  └──────────┘  └────────────┘
```

### 最后的话

Recommendation Service v1 是一个**工程化的推荐系统**，而非黑盒模型。

它的设计哲学是：

> **让 Agent 理解推荐，而不是盲目执行推荐。**

通过显式的 CZ/EZ 分离、可解释的分数组件、可配置的混合策略，v1 为 Taste Aligner 系统提供了坚实的推荐基础，同时保留了充分的演进空间。

---

_Last updated: 2026-01-31_
_Recommendation Service v1 - Taste Aligner Project_
