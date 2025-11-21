# 目的地特征库（Destination Feature Schema）— V1.0（中文版 Part 1）

本文件定义 Taste Aligner V10 中的 **目的地特征库（Destination Feature Database）**，简称 **DFD**。

DFD 是推荐系统中与 **P5 Memory** 并列的重要输入：

- **P5 负责“你是谁，你喜欢什么”**
- **DFD 负责“城市里有什么可推荐的”**

只有两者结合，Matcher Agent 才能计算 CZ/EZ（舒适区 / 探索区）并由 Planner Agent 输出“旅程卡”。

本规范将分为：

1. 目的地特征的定义与设计目标
2. 单个目的地项目的数据结构（Item Schema）
3. 存储与索引（数据库 + 标签体系）

（先写 Part 1，后续 Part 2–3 再补）

---

# **1. 什么是目的地特征（Destination Feature）？**

目的地特征（Destination Feature）是对城市内可推荐项目（景点/美食/体验）的**结构化描述**。它是推荐系统对“城市知识”的数字化表达。

你可以把它理解为：

> **一个城市的美食/景点数据库 + 结构化标签 + 风格标签 + 描述信息**。

在 Taste Aligner 中，一个 Destination Feature 代表：

- 一家餐厅 / 咖啡店 / 甜品店（type=food）
- 一个景点 / 观景点 / 公园（type=scenery）
- 一段体验，例如温泉、徒步路线（type=experience，可扩展）

每个 Destination Item 都包含多模态特征，例如：

- 标签（labels） → 与 P5 Memory 一致
- 风格（style）
- 位置（location）
- 评分与人气（popularity）
- 简介与故事性描述（description）
- 主图（image）

它是推荐引擎计算 CZ/EZ 的另一半基础。

---

# **1.1 为什么需要 Destination Feature？**

原因很直接：

### ❌ 没有 DFD → 系统不知道“这个城市有哪些选择”

- 只能基于 P5 做相似记忆检索
- 无法生成真正的推荐清单
- 无法构成 Planner 的旅程卡结构

### ✔ 有了 DFD → 系统才能生成“可行动”的推荐

- 每个候选项目都有完整标签与特征
- recommendation.score 才能比较 user\_embedding vs item\_embedding
- Planner 才能构建“你在伦敦的旅程卡”

换句话说：

> **P5 是用户的“过去”（History），DFD 是城市的“现在”（Options）。**

推荐系统必须同时看“你是谁”和“你在哪里”。

---

# **1.2 Destination Feature 在系统中的角色**

### **Taste Analyzer Agent**

- 需要标签体系（ontology）中的类别

### **Matcher Agent**

- 使用 DFD 中的标签/风格/坐标 → 构建候选集合（candidate\_items）
- 将候选集合与 P5 记忆做联动

### **Recommendation Engine**

- 将用户画像（TES）与候选目的地向量（item embedding）计算相似度
- 输出 CZ（舒适区）和 EZ（探索区）项目

### **Planner Agent**

- 将目的地项目整合成旅程卡（旅程列表 + 记忆锚点）
- 需要 display\_name, image, reason, location

DFD 是多智能体系统必不可少的组件。

---

# **1.3 设计原则（Design Principles）**

### **原则 1：标签体系与 P5 完全对齐**

- normalized\_labels 必须来自同一个 Tag Ontology
- 这样才能确保：
  - 用户偏好（P5）与目的地标签可以进行相似度计算
  - recommendation.score 能正确打分

### **原则 2：结构化且可扩展**

目的地项目需要支持：

- 新标签
- 新类别（如咖啡、古迹、体验）
- 新的风格 embedding / 图片 embedding

### **原则 3：来源统一（统一数据源格式）**

- 无论是手动输入、城市抓取（scraping）、还是第三方 API
- 最终必须落地为统一 Schema

### **原则 4：可解释性（Explainable）**

目的地项目需要可用于：

- Planner Agent 输出“推荐理由”
- 前端展示丰富信息
- 自然语言解释推荐逻辑

### **原则 5：轻量（Lightweight）**

- 每一项目的地特征结构化字段应尽量精炼
- 文本描述适中（不做长篇百科）
- embedding 按需生成

---

# **1.4 Destination Feature 的三大组成部分**

一个完整的目的地项目由三个核心部分组成：

## **（1）基础信息 Basic Info**

- item\_id
- display\_name
- type（food/scenery/experience）
- location（city/country/lat/lng）
- images（封面图）

## **（2）语义标签 Semantic Tags**

- raw\_labels
- normalized\_labels
- style\_tags
- 推荐引擎可直接使用

## **（3）结构化属性 Structured Attributes**

- popularity（评分/人气）
- price\_level（可选）
- opening\_hours（可选）
- description（可选简介）
- source（数据来源）

后续 Part 2 将定义 **Destination Item Schema（字段级规范）**。

---

（已完成 Part 1，若你准备继续，我会写入 Part 2：单个目的地项目的结构定义）

---

# **2. 单个目的地项目的数据结构（Destination Item Schema）**

本节定义 Taste Aligner V10 中 **单个 Destination Feature Item（目的地项目）** 的完整字段结构。

一个目的地项目代表：

- 一家美食店、咖啡店、甜品店（type = food）
- 一个景点、观景点、博物馆、公园（type = scenery）
- 一段体验项目，如温泉、徒步、骑行（type = experience，可扩展）

Destination Item 是推荐引擎中与 P5 Memory 平行的“候选库（Candidate Pool）”。 因此其标签体系、风格字段、结构化字段必须与 P5 完全兼容。

---

## **2.1 顶级结构（Top-Level Structure）**

以下为单个目的地项目的正式 Schema：

```ts
DestinationItem {
  item_id: string,                      // 全局唯一 ID
  display_name: string,                 // 展示名称
  type: "food" | "scenery" | "experience",

  images: string[] | null,              // 封面图（1-3 张）

  raw_labels: string[],                 // vision / 抓取来源的原始标签
  normalized_labels: string[],          // 经 ontology.normalize 后的标准化标签
  style_tags: string[] | null,          // 可选的风格标签（如 cozy、minimal）

  popularity: number | null,            // 评分或人气 (0~1 或 0~5)
  price_level: number | null,           // 可选（1~5）
  opening_hours: string | null,         // 可选，如 "10:00-20:00"
  description: string | null,           // 可选简介

  location: {
    city: string,
    country: string,
    lat: number | null,
    lng: number | null
  },

  item_embedding: number[] | null,      // 可选的目的地 embedding（预计算）

  source: string,                       // 来源（manual / scrape / api）
  version: number                       // Schema 版本号
}
```

---

## **2.2 字段详细说明（Field Description）**

### **(1) item\_id — 目的地项目 ID**

- 类型：string（UUID）
- 用途：
  - 数据库主键
  - Planner 生成旅程卡时的唯一识别符

### **(2) display\_name — 展示名称**

- 类型：string
- 示例：
  - “Archer Café”
  - “京都清水寺展望台”
- 用途：前端直接显示

### **(3) type — 项目类型**

- food / scenery / experience
- 扩展性强，可未来加入 shopping / culture 等

### **(4) images — 图片数组**

- 用于 UI 显示
- 若抓取来源不足，可填 null

---

## **标签相关字段（Labels & Ontology）**

### **(5) raw\_labels — 原始标签**

- 来自抓取、API 或城市数据
- 示例："ramen", "noodle", "汤", "spicy"

### **(6) normalized\_labels — 规范化标签**

- 必须来自统一 Tag Ontology
- 目的是与 P5 Memory 完全对齐
- 推荐引擎使用此字段计算相似度

### **(7) style\_tags — 风格标签**

- 示例："cozy", "bright", "analog", "minimal"
- 用于构造 item\_embedding（类似 P5 的 style\_embedding）

---

## **结构化字段（Structured Attributes）**

### **(8) popularity — 评分/人气**

- 范围：0\~1 或 0\~5
- 来源：手动输入或第三方 API
- 用途：
  - recommendation.score 作为辅助排序指标
  - 未提供时可为空

### **(9) price\_level — 可选价格等级**

- 范围：1\~5
- 仅对 food 类型有意义

### **(10) opening\_hours — 营业时间**

- 文本格式，如 "10:00–20:00"
- Planner 可用于旅程时间排序（可选）

### **(11) description — 简介**

- 目的地的简单介绍
- 用于 Planner 输出更丰富的旅程卡

---

## **位置字段（Location）**

### **(12) location — 地理信息**

```ts
location: {
  city: string,
  country: string,
  lat: number | null,
  lng: number | null
}
```

- city 与 country 为必填
- lat/lng 可选（未来可做地图展示）

---

## **目的地向量（Item Embedding）**

### **(13) item\_embedding — 可选（推荐生成）**

- 若生成，则结构应与 TES 高度对齐
- 组成方式：
  - 标签 embedding（384）
  - 风格 embedding（16）
  - 地理位置 embedding（可选）
- 用途：
  - recommendation.score 中直接与 user\_embedding 做相似度计算
  - 若为空，则推荐引擎动态生成

---

## **元数据字段（Metadata Fields）**

### **(14) source**

- manual / scrape / api
- 用于说明数据来源

### **(15) version — Schema 版本**

- 默认 1
- 支持未来字段升级

---

# **2.3 ASCII 结构图（Item Schema Overview）**

```text
DestinationItem
│
├── item_id: string
├── display_name: string
├── type: food | scenery | experience
│
├── images: string[] | null
│
├── raw_labels: string[]
├── normalized_labels: string[]
├── style_tags: string[] | null
│
├── popularity: number | null
├── price_level: number | null
├── opening_hours: string | null
├── description: string | null
│
├── location:
│     ├── city: string
│     ├── country: string
│     ├── lat: number | null
│     └── lng: number | null
│
├── item_embedding: number[] | null
│
├── source: string
└── version: number
```

---

（Part 2 完成。如果你准备继续，我会开始写 Part 3：目的地特征的存储与索引设计。）

---

# **3. 目的地特征的存储与索引设计（Storage & Indexing Design）**

目的地特征库（DFD）需要满足：

- **快速查询**（按城市、类别、标签过滤）
- **轻量且可扩展**（允许后续加入新字段）
- **与 P5 Memory 高度兼容**（标签与风格结构一致）
- **便于 Planner/Matcher/RecEngine 使用**

因此本设计采用与 P5 Memory 类似的 **关系型数据库（SQLite/Postgres）＋ 可选向量库（FAISS/Milvus）** 双存储结构。未来可根据 item\_embedding 的需求决定是否启用向量库。

---

## **3.1 关系型数据库结构（Structured Storage）**

推荐使用：

- 本地开发：**SQLite**（轻量、跨平台）
- 未来与服务器同步：**Postgres**（支持 JSON 和全文搜索）

表名：`destination_items`

### **表结构（Schema）**

```sql
CREATE TABLE destination_items (
    item_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    type TEXT CHECK(type IN ('food', 'scenery', 'experience')),

    images JSON,

    raw_labels JSON,
    normalized_labels JSON,
    style_tags JSON,

    popularity REAL,
    price_level INTEGER,
    opening_hours TEXT,
    description TEXT,

    city TEXT NOT NULL,
    country TEXT NOT NULL,
    lat REAL,
    lng REAL,

    item_embedding BLOB,            -- 可选：存 930 维或其它 dim 的向量

    source TEXT,
    version INTEGER DEFAULT 1
);
```

说明：

- `images` 使用 JSON 数组
- `item_embedding` 可为空（RecEngine 可实时生成）
- `lat/lng` 可短期为空，但建议未来填入，提高地理推荐质量

---

## **3.2 向量库结构（Vector Index Storage，可选）**

若你希望推荐速度更快（或未来城市库很大），可对 item\_embedding 建立向量库。

与 P5 不同的是：

- item\_embedding 的维度可以比 TES 小（例如仅标签+风格，≈400 维）
- 也可以直接使用 TES 结构（930 维）以保持最大兼容性

向量库记录格式：

```
index_key = item_id
vector = item_embedding (float32[n])
```

推荐：

- M4 Pro：FAISS Flat / IVF-Flat
- 云端扩展：Milvus

---

## **3.3 查询机制（Query System）**

Matcher Agent 和 Planner Agent 会频繁使用 DFD，因此查询必须高效且字段明确。

### **常用查询类型：**

#### **（1）按城市查询候选项目**

```sql
SELECT * FROM destination_items WHERE city = 'London';
```

#### **（2）按 type（食物/景点）筛选**

```sql
SELECT * FROM destination_items WHERE type = 'scenery';
```

#### **（3）按标签（normalized\_labels）筛选**

可使用 JSON 包含操作：

```sql
SELECT * FROM destination_items
WHERE normalized_labels LIKE '%ramen%';
```

#### **（4）按人气排列**

```sql
SELECT * FROM destination_items ORDER BY popularity DESC;
```

#### **（5）向量相似度检索（可选）**

```python
index.search(query_vector, top_k)
```

RecEngine 会根据：

- 标签相似度
- 风格相似度
- 人气权重
- 城市匹配度 综合排序。

---

## **3.4 写入 / 更新 / 删除规则（W/U/D Rules）**

目的地项目的写入规则比 P5 Memory 稍轻量，因为 DFD 属于静态数据。

### **（1）写入规则（Add）**

- item\_id 必须唯一
- normalized\_labels 必须来自 ontology.normalize
- city/country 必须存在
- images 可为 null

写入流程：

```
Step 1: 校验数据
Step 2: INSERT into destination_items
Step 3: 若提供 item_embedding → 写入向量库
```

### **（2）更新规则（Update）**

- 可更新任意结构化字段
- 若修改 normalized\_labels/style\_tags → 需要重算 item\_embedding

流程：

```
UPDATE destination_items
若重算 item_embedding → 更新向量库
```

### **（3）删除规则（Delete）**

```
DELETE FROM destination_items WHERE item_id=...
若向量库存在 → 同步删除对应 embedding
```

---

## **3.5 初始化流程（Initialization）**

系统启动时 Destination Service 必须：

1. 加载 SQLite / Postgres
2. 若启用向量库：加载 FAISS/Milvus
3. 建立 item\_id → index\_position 映射表（若必要）
4. 校验字段完整性和版本号

---

## **3.6 索引设计（Indexes）**

推荐建立以下索引：

```sql
CREATE INDEX idx_city ON destination_items(city);
CREATE INDEX idx_type ON destination_items(type);
CREATE INDEX idx_popularity ON destination_items(popularity);
CREATE INDEX idx_country_city ON destination_items(country, city);
```

用途：

- 提高 Matcher 的候选集合构建速度
- 提高 Planner 的旅程卡生成速度

---

## **3.7 存储容量规划（Capacity Planning）**

假设每个城市有：

- 80–200 条目的地项目
- 每项 item\_embedding ≈ 400–930 维（float32）

则：

- 200 项 × 400 维 × 4 bytes ≈ **320 KB**
- 200 项 × 930 维 × 4 bytes ≈ **744 KB**

全球 30 城市 → 20–45 MB

非常轻量，M4 Pro 完全足够。

---

## **3.8 文件与目录结构（Directory Layout）**

```
/taste_destination/
    destination.db            # SQLite
    dest_index.faiss          # 可选向量库
    id_map.json               # item_id → FAISS index

/service/
    destination_service.py    # Destination API

/gateway/
    gateway.java              # 工具桥接
```

---

## **3.9 小结（Summary）**

Destination Feature 的存储与索引体系确保：

- 查询高效
- 结构轻量
- 与 P5 的标签体系完全兼容
- 支持未来模型扩展

这使得 recommended.score 能够快速构建候选集合，并与用户画像进行匹配。

---

