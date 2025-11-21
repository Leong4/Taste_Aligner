# Tool Registry (Taste Aligner V10)

本文件用于定义所有 Agent 将调用的工具（Tools）的输入/输出规范，是整个系统保持一致性的核心。

---

## **Tool 1: memory.search**

**用途：** 用于从用户的多模态记忆库（P5 + TES 向量空间）中检索与查询最相似的记忆单元。此工具是 Taste Aligner 推荐系统的基础，用于激活“记忆锚点”。

**调用方（Agent）：**

- Taste Analyzer Agent
- Matcher Agent
- Planner Agent（用于关联记忆锚点）

**提供方（Service）：**

- Memory Service（Python / Node 皆可）

### **输入参数（Input）**

```
{
  "query_vector": number[],       // TES 查询向量（由 Embedding Service 生成）
  "top_k": number,                //Top K 检索数量
  "filters": {                    //可选过滤
       "type": "food" | "scenery",   //限制美食或风景
       "location": string | null       //可选按地点过滤
  }
}
```

### **输出结构（Output）**

```
{
  "results": [
      {
        "memory_id": string,            //记忆单元 ID
        "score": number,                //相似度得分（0~1）
        "type": "food" | "scenery",   //类别
        "tags": string[],               //底层标签
        "sentiment": number,            //情感得分
        "location": {
            "city": string,
            "country": string
        },
        "timestamp": string,            //ISO 时间
        "image": string                 //图片本地路径（前端可直接使用）
      }
  ]
}
```

### **错误格式（Error Format）**

所有工具都遵守统一错误格式：

```
{
  "error": true,
  "message": string,
  "code": string      //如 MEMORY_TIMEOUT / VECTOR_DIM_MISMATCH / INTERNAL_ERROR
}
```

### **降级策略（Degradation）**

- 若向量库不可用 → 使用缓存结果（Cache Layer）
- 若 top\_k=0 或无结果 → 返回空列表，不报错
- 若输入向量维度不一致 → Gateway 拦截并返回 VECTOR\_DIM\_MISMATCH

### **备注**

memory.search 是所有后续工具的基础，因此必须保证：

- 输入/输出结构稳定
- 返回内容可被多个 Agent 复用
- 具备幂等性与快速响应能力（可缓存）

---

## **Tool 2: vision.describe**

**用途：**\
接收用户上传的图片，并返回图片的底层标签、食物/场景特征、视觉风格、可能的类别归属（美食或风景）。这是多模态记忆单元（P5）中视觉信号的来源，也是 TES 向量生成的第一个步骤。

**调用方（Agent）：**

- Intent Agent（用于解析用户上传的新图）
- Taste Analyzer Agent（构建品味画像）
- Planner Agent（生成旅程卡时需要 anchor 信息）

**提供方（Service）：**

- Vision Service（Python）

### **输入参数（Input）**

```
{
  "image_path": string,           //本地图片路径，由前端上传后保存
  "require_style": boolean,       //是否需要风格标签（如文艺、复古）
  "require_food_check": boolean   //是否判断食物/风景类别
}
```

### **输出结构（Output）**

```
{
  "labels": string[],                 //基础标签，例如 noodle, soup, spicy, mountain
  "confidence": number[],             //与 labels 对齐的置信度
  "style_tags": string[] | null,      //可选：视觉风格，如 bright, analog, cozy
  "type": "food" | "scenery",       //模型判断的类别
  "raw_description": string,          //LLM 对图片的一句自然语言总结
  "embedding": number[] | null        //可选：CLIP embedding，用于 fallback
}
```

### **错误格式（Error Format）**

```
{
  "error": true,
  "message": string,
  "code": string       //如 VISION_TIMEOUT / BAD_IMAGE_FORMAT / INTERNAL_ERROR
}
```

### **降级策略（Degradation）**

- 若 GPT-4V/Gemini Vision 不可用 → 启动本地 CLIP + LLaVA fallback 模式
- 若图片格式不支持 → Gateway 在输入校验阶段直接拒绝
- 若 require\_style=true 但无风格检测 → 返回 null，不报错
- 若无法判定 type → 返回 "food" 或 "scenery" 的默认概率值（按标签分布）

### **备注**

vision.describe 结果将直接进入：

- Ontology Service（标签规范化）
- Embedding Service（TES 生成）
- Memory Service（存储 P5 多模态记忆）

因此返回内容必须：

- 标签结构清晰
- 全局字段名固定
- 尽可能稳定

---

## **Tool 3: ontology.normalize**

**用途：**\
将 Vision Service 生成的原始标签（可能包含噪声、同义词、语言混合、格式不一致）映射到系统内部的**标准化标签体系（Tag Ontology）**。这是整个品味画像（TES）中最关键的“标签清洗层”，确保不同服务和模型之间的标签语义一致。

**调用方（Agent）：**

- Taste Analyzer Agent（构建用户底层偏好标签）
- Embedding Service（生成标签 embedding）
- Recommendation Engine（依赖统一标签）

**提供方（Service）：**

- Ontology Service（Node / Python）

---

### **输入参数（Input）**

```
{
  "raw_labels": string[],       //来自 vision.describe 的标签，如 ["noodle", "汤", "spicy"]
  "language": string | null,    //可选：原标签语言（zh/en/jp），用于跨语言映射
  "context": "food" | "scenery" | null   //可选：场景类型，有助于标签歧义消解
}
```

---

### **输出结构（Output）**

```
{
  "normalized_labels": string[],       //系统统一标签，如 ["noodle", "soup", "spicy"]
  "ignored_labels": string[],          //被过滤掉的无效标签
  "confidence_map": {                  //标签 → 置信度
      "noodle": 0.94,
      "soup": 0.88,
      "spicy": 0.76
  }
}
```

**说明：** normalized\_labels 必须来自系统的**统一标签库（Tag Ontology Dictionary）**，保证后续 embedding 、推荐引擎都能使用一致的标签系统。

---

### **错误格式（Error Format）**

遵守全局规范：

```
{
  "error": true,
  "message": string,
  "code": string    //如 ONTOLOGY_TAG_NOT_FOUND / BAD_LABEL_FORMAT
}
```

---

### **降级策略（Degradation）**

- 若标签不在词典中 → 使用简单规则映射（lowercase → trim → plural remove）
- 若语言不明确 → 默认使用英文映射
- 若 raw\_labels 全为空 → 返回 normalized\_labels = []
- 若 Service 超时 → Gateway 返回 cached mapping（缓存版标签 mapping）

---

### **备注**

ontology.normalize 的目标是 **“让 Taste Aligner 的所有标签系统统一且干净”**。\
它是多模态系统中最容易出错的地方，因此需要：

- 字段名固定、不随意改动
- 标签词典独立存放于 /docs/tag\_ontology.md（未来会创建）
- 输出结构必须能被 Embedding Service 直接使用

---

## **Tool 4: embedding.generate**

**用途：**\
将多模态输入（视觉 embedding、规范化标签、情感得分、时间权重等）融合成 Taste Embedding Space（TES）的统一高维向量。该工具直接决定了品味画像的质量，是 CZ/EZ 推荐算法的数学基础。

**调用方（Agent / Service）：**

- Taste Analyzer Agent（生成偏好向量）
- Memory Service（为每条记忆生成 P5 向量）
- Recommendation Engine（计算相似度）

**提供方（Service）：**

- Embedding Service（Python）

---

### **输入参数（Input）**

```
{
  "visual_embedding": number[] | null,     //来自 vision.describe 的 CLIP 向量（可空）
  "labels": string[],                      //已规范化的标签（由 ontology.normalize 输出）
  "sentiment": number | null,              //[-1,1] 区间的情感分数，可空
  "timestamp": string | null,              //ISO 格式的时间，用于 recency decay
  "location": {
      "city": string | null,
      "country": string | null
  },
  "mode": "memory" | "query"             //memory=构建 P5，query=用户查询向量
}
```

---

### **输出结构（Output）**

```
{
  "embedding": number[],         //最终 TES 向量（d 维，固定维度）
  "components": {                //可选：调试用，保留各部分贡献值
      "visual": number[],
      "tags": number[],
      "sentiment": number[],
      "recency": number[],
      "location": number[]
  }
}
```

**说明：** components 字段用于 debug 模式，让开发者理解 TES 向量是如何组成的；正式生产环境可不返回。

---

### **错误格式（Error Format）**

```
{
  "error": true,
  "message": string,
  "code": string     //如 EMBEDDING_DIM_ERROR / EMPTY_INPUT
}
```

---

### **降级策略（Degradation）**

- 若 visual\_embedding = null → 使用标签 embedding 与情感/时间组件生成向量
- 若标签为空 → 使用视觉 + 情感 + 时间向量
- 若 sentiment 缺失 → sentiment 向量维度用 0 填充
- 若 timestamp 缺失 → recency 设为 1（表示最近）
- 若 Service 超时 → Gateway 使用上一次缓存的 embedding

---


### **备注**

embedding.generate 必须：

- 输出维度固定（TES 统一维度）
- 保证任何输入组合都能生成 embedding
- 与 memory.search 完全兼容（维度一致）

这是 Taste Aligner 推荐系统中最重要的数学核心之一。

---

## **Tool 5: recommendation.score**

**用途：**\
基于多模态偏好画像（TES 向量）、目的地特征标签、以及探索区 / 舒适区的评分模型计算推荐得分。该工具是 Taste Aligner 的**决策核心**，用于输出：

- CZ（舒适区）得分
- EZ（探索区）得分
- 推荐的初步排序结果

这是整个系统从“理解用户”进入“做出判断”的关键桥梁。

**调用方（Agent）：**

- Matcher Agent（主调用方）
- Planner Agent（辅助调用，用于旅程卡排序）

**提供方（Service）：**

- Recommendation Engine（Node / Python 均可）

---

### **输入参数（Input）**

```
{
  "user_embedding": number[],               //用户品味画像（query向量）
  "candidate_items": [                     //候选：来自目的地特征库或 Memory
      {
        "item_id": string,
        "type": "food" | "scenery",
        "tags": string[],                 //目的地项目的标签
        "popularity": number | null,       //可选：当地或全球评分
        "location": {
            "city": string | null,
            "country": string | null
        }
      }
  ],
  "mode": "food" | "scenery" | "mixed"  //推荐类型
}
```

---

### **输出结构（Output）**

```
{
  "comfort_zone": [                     //按得分排序的前 K 个 CZ 项目
      {
        "item_id": string,
        "score_cz": number,            //舒适区得分
        "reason": string               //推荐理由（可选）
      }
  ],
  "exploration_zone": [                //按得分排序的前 K 个 EZ 项目
      {
        "item_id": string,
        "score_ez": number,            //探索区得分
        "reason": string
      }
  ],
  "debug": {                           //可选：调试信息
      "cz_weight": number,
      "ez_weight": number,
      "tag_overlap": any,
      "distance": any
  }
}
```

**说明：**

- comfort\_zone 和 exploration\_zone 必须拆开输出，方便 Planner Agent 使用。
- reason 字段用于可解释性（例如“与你的辛辣偏好接近”）。

---

### **错误格式（Error Format）**

```
{
  "error": true,
  "message": string,
  "code": string   //如 RECOMMENDATION_EMPTY_INPUT / SCORE_MODEL_FAIL
}
```

---

### **降级策略（Degradation）**

- 若 candidate\_items = [] → 返回两个空列表
- 若 user\_embedding 为空 → fallback 使用标签相似度（Jaccard）计算
- 若内部评分公式失败 → 返回默认排序（按 popularity）
- 若微服务不可用 → Gateway 使用上次缓存得分

---

### **备注**

recommendation.score 必须：

- 输出 CZ 和 EZ 的明确区分
- 兼容 Planner Agent 的旅程卡生成格式
- 对 small / large destinations 都要稳定
- 对全零输入有 fallback 逻辑

---

## **Tool 6: planner.compose**

**用途：**\
将推荐引擎的输出（CZ/EZ 列表）与记忆检索结果、目的地信息结合，生成最终的“个性化旅程卡”结构。该结构会被前端（Electron + React）直接渲染，是整个系统的最终交付成果。

planner.compose 的目标是：

- 整合多 Agent 的信息
- 明确舒适区 / 探索区的呈现顺序
- 绑定“记忆锚点”（Memory Anchors）
- 输出一个“可视化友好”的结构供 UI 使用

**调用方（Agent）：**

- Planner Agent（最终决策者）

**提供方（Service）：**

- Planner Service（Node）

---

### **输入参数（Input）**

```
{
  "comfort_zone": [             //来自 recommendation.score
      {
        "item_id": string,
        "score_cz": number,
        "reason": string
      }
  ],
  "exploration_zone": [
      {
        "item_id": string,
        "score_ez": number,
        "reason": string
      }
  ],
  "memory_anchors": {           //来自 memory.search
      "item_id": {
         "memory_id": string,  //对应记忆单元
         "image": string,      //记忆锚点图片
         "source": string      //描述该锚点的体验，例如“四姑娘山徒步”
      }
  },
  "destination": {
      "city": string,
      "country": string
  }
}
```

---

### **输出结构（Output）**

```
{
  "title": string,            //如“你的专属伦敦旅程卡”
  "subtitle": string,         //如“基于你的Taste Profile自动生成”
  "sections": [               //前端渲染卡片用
      {
        "section_type": "comfort_zone" | "exploration_zone",
        "items": [
            {
              "item_id": string,
              "display_name": string,
              "reason": string,
              "memory_anchor": {
                 "image": string,
                 "source": string
              }
            }
        ]
      }
  ]
}
```

说明：display\_name 会在 Planner Service 内部根据 item\_id 查询目的地数据库或静态配置得到。

---

### **错误格式（Error Format）**

```
{
  "error": true,
  "message": string,
  "code": string      //如 PLANNER_INPUT_EMPTY / ANCHOR_NOT_FOUND / INTERNAL_ERROR
}
```

---

### **降级策略（Degradation）**

- 若某项无 memory\_anchor → 使用默认“探索图标”
- 若得分相同 → 按 item\_id 字典序排序
- 若 CZ 或 EZ 为空 → 只输出另一个区
- 若目的地信息缺失 → 使用通用标题“你的专属旅程卡”

---

### **备注**

- planner.compose 是最终“产品化”环节，必须保证输出结构稳定且可视化友好
- 产生的结构 JSON 会传给前端组件渲染成展示卡
- 不要在这个层面做模型逻辑，保持轻量

---



