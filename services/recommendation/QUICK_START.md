# Recommendation Service v1 - Quick Start

## 快速启动

### 1. 启动服务

```bash
cd services/recommendation
python3 main.py
```

服务运行在：`http://localhost:5005`

### 2. 健康检查

```bash
curl http://localhost:5005/health | python3 -m json.tool
```

### 3. 运行验证测试

```bash
# 自动化测试（推荐）
./test_recommendation.sh

# 手动测试
python3 test_recommendation.py

# v1.3 验证（可选）
python3 validate_v1_3.py
```

---

## 验证命令（Validation Commands）

### Test 1: Tokyo + ramen (Strong CZ Expected)

**场景：** 用户在东京，喜欢拉面、夜生活、散步

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

- **Recall:**
  - `total_candidates`: ~11
  - `recall_rules`: `["city_match", "tag_overlap", "ez_global_excellence"]`

- **CZ Ranked (Top 3):**
  1. Ichiran Ramen (tag_similarity ≈ 0.5+, 完美匹配 "ramen")
  2. Omoide Yokocho (tag_similarity ≈ 0.33+, 匹配 "nightlife")
  3. Golden Gai (tag_similarity ≈ 0.33+, 匹配 "nightlife" + "walk")

- **Mix Policy:**
  - `rule`: `"cz_strong"`
  - `cz:ez`: `3:1`
  - 原因：CZ 标签匹配非常强，用户偏好明确

**可用于 Agent/Planner 的字段：**

```json
{
  "cz_ranked": [
    {
      "item_id": "tokyo_001",
      "score_CZ": 2.12,
      "components": {
        "tag_similarity": 0.5,      // ← Planner: 匹配度
        "memory_influence": 1.2,     // ← Planner: 历史喜好
        "location_relevance": 1.0    // ← Planner: 同城加成
      },
      "reason": "strong taste match + same location",
      "item": {
        "name": "Ichiran Ramen Shibuya",
        "raw_tags": ["ramen", "japanese", "noodles", "comfort"]
      }
    }
  ],
  "mix_policy": {
    "rule": "cz_strong",
    "confidence": 0.78  // ← Planner: 策略置信度
  }
}
```

---

### Test 2: Tokyo + empty tags (EZ Fallback Expected)

**场景：** 用户在东京，但没有明确偏好标签

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

- **Recall:**
  - 依赖 `city_match` 和 `ez_global_excellence` 规则
  - 卓越度 ≥ 0.8 的项目会被召回

- **EZ Ranked (Top):**
  1. Sukiyabashi Jiro (`global_excellence` = 0.98, 三星寿司)
  2. Senso-ji Temple (`global_excellence` = 0.92)
  3. TeamLab Borderless (`global_excellence` = 0.91)

- **Mix Policy:**
  - `rule`: `"balanced"` 或 `"ez_attractive"`
  - 原因：没有明确的 CZ 信号，EZ 的高卓越度项目更有吸引力

**可用于 Agent/Planner 的字段：**

```json
{
  "ez_ranked": [
    {
      "item_id": "tokyo_002",
      "score_EZ": 1.48,
      "components": {
        "global_excellence": 0.98,    // ← Planner: 世界级质量
        "taste_distance": 0.0          // ← Planner: 无偏好时距离为 0
      },
      "why_explore": "world_class_slightly_different"
    }
  ]
}
```

---

### Test 3: Paris + coffee (Cultural Transfer)

**场景：** 用户在巴黎，喜欢咖啡、咖啡馆、散步

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

- **Recall:**
  - 巴黎所有项目（city_match）
  - 标签匹配 "cafe", "walk" 的项目

- **CZ Ranked (Top):**
  1. Café de Flore (标签匹配 "cafe")
  2. Le Marais Walk (标签匹配 "walk")
  3. Shakespeare and Company (标签匹配 "coffee" + "walk")

- **Mix Policy:**
  - `rule`: `"cz_strong"` 或 `"balanced"`
  - location_relevance = 1.0（同城）

**可用于 Agent/Planner 的字段：**

```json
{
  "cz_ranked": [
    {
      "components": {
        "location_relevance": 1.0  // ← Planner: 在用户所在城市
      },
      "reason": "strong taste match + same location"
    }
  ]
}
```

---

### Test 4: Milan + design (Exploration Expected)

**场景：** 用户在米兰，喜欢设计、艺术、现代风格

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

- **CZ Ranked:**
  1. Triennale Design Museum (完美匹配 "design", "modern")
  2. Fondazione Prada (匹配 "art", "modern")
  3. 10 Corso Como (匹配 "design")

- **EZ Ranked:**
  1. Duomo di Milano (`global_excellence` = 0.96, 虽然是建筑，但高质量)
  2. Fondazione Prada（也可能在 EZ，因为 excellence = 0.92）

- **Mix Policy:**
  - `rule`: `"balanced"`
  - CZ 和 EZ 都有强候选

**可用于 Agent/Planner 的字段：**

```json
{
  "cz_ranked": [
    {
      "item_id": "milan_006",
      "components": {
        "tag_similarity": 0.67  // ← "design" + "modern" 匹配
      }
    }
  ],
  "ez_ranked": [
    {
      "item_id": "milan_008",
      "components": {
        "global_excellence": 0.96,
        "taste_distance": 0.67
      },
      "why_explore": "exceptional_quality_low_overlap"
    }
  ],
  "mix_policy": {
    "delta": 0.15,  // ← CZ 和 EZ 分数接近
    "rule": "balanced"
  }
}
```

---

## Agent/Planner 集成示例

### 场景：Planner 使用推荐结果生成行程

```python
# 1. 调用推荐服务
response = requests.post("http://localhost:5005/score", json={
    "data": {
        "user_id": "u001",
        "city": "tokyo",
        "tags": ["ramen", "nightlife"]
    }
}).json()

# 2. 提取 CZ 和 EZ 项目
cz_items = response["cz_ranked"]
ez_items = response["ez_ranked"]
mix_policy = response["mix_policy"]

# 3. Planner 应用混合策略
if mix_policy["rule"] == "cz_strong":
    # 主推 CZ，少量 EZ
    selected = cz_items[:3] + ez_items[:1]
elif mix_policy["rule"] == "balanced":
    # 平衡推荐
    selected = cz_items[:2] + ez_items[:1]
else:
    # EZ 吸引力强
    selected = cz_items[:1] + ez_items[:2]

# 4. Planner 添加约束过滤
# 例如：预算限制、时间限制
filtered = [
    item for item in selected
    if satisfies_budget(item) and satisfies_time(item)
]

# 5. Planner 生成最终行程
itinerary = generate_itinerary(filtered)
```

### 可解释性示例

```python
# 向用户解释推荐理由
for item in cz_items[:3]:
    print(f"推荐: {item['item']['name']}")
    print(f"理由: {item['reason']}")

    # 详细分解
    components = item['components']
    if components['tag_similarity'] > 0.7:
        print("  → 与你的偏好高度匹配")
    if components['memory_influence'] > 1.0:
        print("  → 基于你的历史喜好")
    if components['location_relevance'] == 1.0:
        print("  → 就在你所在的城市")
```

---

## 关键字段说明

### Recall 阶段

| 字段 | 说明 | Planner 用途 |
|------|------|-------------|
| `total_candidates` | 召回的候选数量 | 判断是否需要扩大搜索范围 |
| `recall_rules` | 触发的召回规则 | 理解为什么召回这些项目 |
| `stats.city_matches` | 城市匹配数量 | 评估本地可选项数量 |

### CZ Rerank

| 字段 | 说明 | Planner 用途 |
|------|------|-------------|
| `score_CZ` | CZ 最终分数 | 排序和选择 |
| `components.tag_similarity` | 标签相似度 [0,1] | 评估匹配度 |
| `components.memory_influence` | 记忆影响 [0,~1.5] | 基于历史偏好 |
| `components.location_relevance` | 位置相关性 [0.5,1] | 同城优先 |
| `reason` | 人类可读理由 | 生成解释文本 |

### EZ Rerank

| 字段 | 说明 | Planner 用途 |
|------|------|-------------|
| `score_EZ` | EZ 最终分数 | 排序和选择 |
| `components.global_excellence` | 全局质量 [0,1] | 识别世界级项目 |
| `components.taste_distance` | 品味距离 [0,0.7] | 评估探索幅度 |
| `why_explore` | 探索理由标签 | 解释为什么推荐不同的 |

### Mix Policy

| 字段 | 说明 | Planner 用途 |
|------|------|-------------|
| `rule` | 策略规则名 | 理解推荐策略 |
| `cz` | 建议 CZ 数量 | 混合比例参考 |
| `ez` | 建议 EZ 数量 | 混合比例参考 |
| `confidence` | 策略置信度 [0,1] | 决定是否覆盖 |
| `delta` | 分数差 (CZ-EZ) | 评估 CZ 强度 |

---

## 调试技巧

### 查看完整响应结构

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data": {"user_id": "test", "city": "tokyo", "tags": ["ramen"]}}' \
  | python3 -m json.tool > response.json

# 查看响应
cat response.json
```

### 检查权重配置

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data": {"user_id": "test", "city": "tokyo", "tags": []}}' \
  | jq '.debug.weights'
```

输出：

```json
{
  "cz": {
    "alpha": 1.0,
    "beta": 0.6,
    "gamma": 0.3
  },
  "ez": {
    "mu": 1.0,
    "nu": 0.4
  }
}
```

### 检查阈值配置

```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data": {"user_id": "test", "city": "tokyo", "tags": []}}' \
  | jq '.debug.thresholds'
```

输出：

```json
{
  "mix_t_high": 0.5,
  "mix_t_mid": 0.2,
  "recall_ez_excellence": 0.8
}
```

---

## 常见问题

### Q1: 为什么 CZ 和 EZ 可能包含相同项目？

A: 这是设计行为。一个项目可以同时：
- 在 CZ 中得分高（因为标签匹配）
- 在 EZ 中得分高（因为全局卓越度高）

Planner 可以根据上下文选择使用哪个分数。

### Q2: 如何调整推荐更保守/更探索？

A: 编辑 `config.py`：

```python
# 更保守（增加 CZ 权重）
CZ_ALPHA = 1.2  # 增加标签相似度权重
CZ_BETA = 0.8   # 增加记忆影响权重

# 更探索（降低 CZ，增加 EZ）
EZ_MU = 1.2     # 增加卓越度权重
MIX_T_HIGH = 0.3  # 降低阈值，更容易触发 EZ
```

### Q3: Recall 返回太少候选怎么办？

A: 有几个选项：

1. **降低 EZ 卓越度阈值**
   ```python
   RECALL_EZ_EXCELLENCE_THRESHOLD = 0.7  # 原来 0.8
   ```

2. **添加更多召回规则**（v2）
   - 文化邻近城市
   - 同类型项目

3. **扩展种子数据**
   - 在 `dataset.py` 添加更多项目

---

详细文档：[RECOMMENDATION_V1_CN.md](RECOMMENDATION_V1_CN.md)
