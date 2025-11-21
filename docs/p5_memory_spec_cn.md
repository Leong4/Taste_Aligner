# P5 多模态记忆结构（P5 Memory Schema）— V1.0

本文件用于定义 Taste Aligner V10 中的 **P5 多模态记忆单元（P5 Memory Unit）** 结构。

它是：

- 用户长期偏好的“记忆仓库”
- TES（Taste Embedding Space）向量的落地载体
- recommendation.score 与 memory.search 的数据来源



## **1. P5 的定义与设计目标（Purpose of P5 Memory）**

P5（Personalized Multimodal Preference Profile）是 Taste Aligner 中负责存储用户“真实体验”和“长期偏好”的核心记忆结构。它对应现实世界中的：

- **用户去过的餐厅 / 景点**
- **上传过的图片**
- **对某次体验的主观感受（情绪 + 偏好强度）**
- **在什么时候、什么地点形成的体验**
- **系统根据这些体验学习到的多模态 embedding（TES 向量）**

因此，每一条 P5 记忆不仅仅是一个“记录”，而是一份完整的偏好证据，包括：视觉 → 语义 → 风格 → 情绪 → 时间 → 地点 → TES。

换句话说：

#  **P5 记忆 = 用户偏好学习的“原子单位（Atomic Unit）”**

TES 是数学空间，P5 是它在现实世界的载体。

---

## **1.1 为什么需要 P5？（Why P5 Exists）**

Taste Aligner 的目标是做“个性化旅程推荐”。

传统推荐系统的弱点：

- 只看评分（不够细）
- 只看标签（不够深）
- 不理解视觉风格（缺乏审美）
- 不理解情绪（缺乏温度）
- 无法随时间动态变化（缺乏记忆衰减）

而 P5 解决了所有这些问题：

| 维度  | P5 的贡献                      |
| --- | --------------------------- |
| 视觉  | 记录用户上传的图像 embedding（最真实的偏好） |
| 语义  | 保存统一标签体系（跨模型一致）             |
| 风格  | 捕捉“你喜欢的氛围感”                 |
| 情绪  | 捕捉“你有多喜欢这一次体验”              |
| 时间  | 越新的体验影响越大（recency）          |
| 地点  | 利用地理偏好，在旅行推荐时做迁移            |
| TES | 用模型学到的完整“品味画像”              |

P5 是 Taste Aligner 能够“记住你是谁”的关键。

---

## **1.2 谁会使用 P5？（Who Uses P5?）**

### **（1）Memory Service**

负责：

- 写入 P5
- 读取 P5
- 检索相似记忆（memory.search）

### **（2）Recommendation Engine**

利用 P5 学到：

- 用户偏好主方向（Comfort Zone）
- 用户可探索区域（Exploration Zone）

### **（3）Taste Analyzer Agent**

从 P5 中：

- 找用户强偏好标签
- 生成 Taste Profile（TES query）

### **（4）Planner Agent**

将 P5 中与目的地匹配的记忆作为“记忆锚点（Memory Anchor）”。

---

## **1.3 P5 的设计原则（Design Principles）**

### **原则 1：单条记忆必须“信息完整”**

每个 P5 Item 必须同时包含：

- 原图或图链接
- 规范化标签
- 风格标签（有则写，无则 null）
- 情感强度
- 时间戳
- 地点
- TES（930 维）

### **原则 2：可扩展（Extensible）**

未来可以加入：

- 更高维度 TES（V2.0）
- 对话体验（NLP embedding）
- 视频 embedding
- 社交关系 embedding

P5 Schema 必须支持横向扩展。

### **原则 3：稳定（Stable）**

字段名永不修改，以保证：

- 向量库不会失效
- Gateway Schema 不会崩溃
- 多 Agent 协作始终一致

### **原则 4：可解释（Explainable）**

每条记忆都必须能被 Planner 解释成：

- 推荐理由
- 回忆锚点
- 偏好模式证据

---

## **1.4 小结**

P5 是整个 Taste Aligner 的“偏好大脑”。
它通过多模态方式将用户的真实体验转化为数学向量（TES），再通过记忆检索与推荐模型帮助系统：

- 记住你过去喜欢什么
- 推断你现在可能喜欢什么
- 推测你未来愿意探索什么



## **2. 单条 P5 记忆单元的字段结构（P5 Memory Unit Schema）**

本节定义 **一条 P5 记忆单元（Memory Unit）** 在数据库、向量库与微服务之间应保持的统一结构。\
这是整个 P5 系统的核心规范，任何后端服务（Memory Service、Embedding Service、Recommendation Engine）都必须严格遵守。

P5 Memory Unit = **用户一次真实体验的所有信息**（图像 + 标签 + 风格 + 情绪 + 时间 + 地点 + embedding）。

下面给出正式 Schema（字段解释 + 类型 + 设计理由）。

---

# **2.1 顶级结构（Top-Level Structure）**

```
P5_Memory_Unit {
    memory_id: string,
    user_id: string,
    type: "food" | "scenery",

    raw_image: string | null,
    image_embedding: number[] | null,

    raw_labels: string[],
    normalized_labels: string[],
    style_tags: string[] | null,

    sentiment: number,                 // [-1, 1]
    timestamp: string,                 // ISO-8601 时间格式

    location: {
        city: string | null,
        country: string | null
    },

    tes_embedding: number[],           // 930 维

    source: string,                    // 该记忆来自哪里（manual / import / user_upload）
    notes: string | null,              // 用户备注，例如“生日一起吃的拉面”

    version: number                    // Schema 版本号，默认 1
}
```

---

# **2.2 字段详细说明（Field Description）**

下面按照逻辑顺序解释每个字段的意义、类型与设计理由。

---

## **(1) memory\_id — 全局记忆 ID**

- 类型：string（UUID）
- 用途：唯一标识一条 P5 记忆
- 说明：
  - 由 Memory Service 负责生成
  - 是向量库（FAISS / Milvus）中的主键

---

## **(2) user\_id — 用户 ID**

- 类型：string
- 用途：区分不同用户的记忆空间
- 说明：
  - 单用户系统可默认写 "user\_1"
  - 多用户时需通过 JWT/session 传递

---

## **(3) type — 记忆类型**

- 类型："food" | "scenery"
- 用途：决定推荐模式（CZ / EZ 权重差异）
- 来源：vision.describe + ontology.normalize

---

# **视觉相关字段（Visual Fields）**

## **(4) raw\_image — 原图路径**

- 类型：string | null
- 内容：用户上传图像的本地路径
- 用途：
  - Planner 生成旅程卡的展示图
  - Fallback（重新生成 embedding）

## **(5) image\_embedding — 原始视觉 embedding**

- 类型：number[] | null
- 内容：CLIP/SigLip embedding（512）
- 用途：
  - fallback 再训练 TES
  - debug 分析
- 说明：TES 是最终向量，image\_embedding 是辅助存储

---

# **标签系统字段（Labels & Ontology）**

## **(6) raw\_labels — 原始标签**

- 类型：string[]
- 来源：vision.describe

## **(7) normalized\_labels — 规范化标签**

- 类型：string[]
- 来源：ontology.normalize
- 用途：
  - 建立跨语言、跨模型一致的标签体系
  - tag\_embedding（TES）使用此字段

## **(8) style\_tags — 风格标签**

- 类型：string[] | null
- 来源：vision.describe（若无则填 null）
- 用途：构建 style\_embedding（16 维）

---

# **情绪、时间、地点（Sentiment / Time / Location）**

## **(9) sentiment — 情绪强度**

- 类型：number（范围 [-1, 1]）
- 用途：用于 sentiment\_scalar（TES 1 维）

## **(10) timestamp — 时间戳**

- 类型：string（ISO-8601）
- 用途：求 recency\_scalar（TES 1 维）

## **(11) location — 地理信息**

```
location: {
    city: string | null,
    country: string | null
}
```

- 用途：生成 location\_embedding（16 维）

---

# **TES（Taste Embedding Space）相关字段**

## **(12) tes\_embedding — 930 维统一向量**

- 类型：number[]（固定长 930）
- 来源：embedding.generate
- 用途：
  - memory.search 检索主向量
  - recommendation.score 作为 item\_embedding

TES = visual(512) + tags(384) + style(16) + sentiment(1) + recency(1) + location(16)

---

# **元数据（Metadata Fields）**

## **(13) source — 记忆来源**

- 类型：string
- 示例："user\_upload", "manual", "import", "scraped"
- 用途：便于管理和 debug

## **(14) notes — 用户备注**

- 类型：string | null
- 示例：“生日那天在大阪吃的拉面”
- 用途：用于 Planner 生成旅程卡的故事化呈现

## **(15) version — Schema 版本**

- 类型：number（默认 1）
- 用途：未来 TES 升级到 V2.0 时向下兼容

---

## **2.3 完整结构图示（ASCII Schema）**

```
P5 Memory Unit
│
├── memory_id: string
├── user_id: string
├── type: food | scenery
│
├── raw_image: string | null
├── image_embedding: number[] | null
│
├── raw_labels: string[]
├── normalized_labels: string[]
├── style_tags: string[] | null
│
├── sentiment: number
├── timestamp: string
├── location:
│     ├── city: string | null
│     └── country: string | null
│
├── tes_embedding: number[930]
│
├── source: string
├── notes: string | null
└── version: number
```

---



## **3. P5 的存储结构与索引设计（Storage & Indexing）**

P5 Memory 的存储系统必须同时满足：

- **高性能检索**（相似体验召回）
- **结构化查询**（根据时间 / 地点 / 类型过滤）
- **可扩展性**（未来用户量、记忆量增加）
- **可维护性**（可视化、调试、版本升级）

因此 P5 的存储设计采用 **两层架构**：

# **关系型数据库（SQLite/Postgres） + 向量库（FAISS/Milvus）双存储结构**

关系型存储结构化字段；向量库存储 tes\_embedding（930 维）。

---

# **3.1 关系型数据库结构（Structured Storage）**

关系型数据库用于存储所有 **非向量** 字段。

推荐：

- 本地：SQLite（轻量 + 单机）
- 未来扩展：Postgres（支持向量插件 pgvector）

表名：**p5\_memory**

### **表结构（Schema）**

```
CREATE TABLE p5_memory (
    memory_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT CHECK(type IN ('food', 'scenery')),

    raw_image TEXT,
    image_embedding BLOB,          -- 可选：保存序列化后的 512 维 embedding

    raw_labels JSON,
    normalized_labels JSON,
    style_tags JSON,

    sentiment REAL,
    timestamp TEXT,

    city TEXT,
    country TEXT,

    source TEXT,
    notes TEXT,
    version INTEGER DEFAULT 1
);
```

### **为什么关系型？**

- 结构化字段查询方便（WHERE city='Osaka'）
- 可以分页、排序（ORDER BY timestamp DESC）
- SQLite/Postgres 都易部署
- Memory Service 可以灵活增删字段

---

# **3.2 向量库结构（Vector Index Storage）**

930 维 tes\_embedding 不能放在关系型数据库中（性能太差），因此采用独立向量库。

推荐：

- FAISS（本地、轻量、适合 M4 Pro）
- Milvus（未来云端扩展）

向量库索引字段：

```
index_key = memory_id
vector = tes_embedding (float32[930])
```

向量索引类型：

- L2 / Cosine 相似度
- IVF+Flat（大规模）或 Flat（小规模）

### **索引示例（FAISS）**

```
d = 930
index = faiss.IndexFlatIP(d)   # 内积相似度
index.add(vectors)             # 按 memory_id 对应
```

---

# **3.3 混合查询路径（Query Flow）**

查询记忆时，系统会同时利用两个数据源：

### **（1）向量召回（memory.search 的第一步）**

```
TES_query → 向量库 → 得到 top_k memory_id
```

### **（2）结构化过滤（Memory Service 第二步）**

```
SELECT * FROM p5_memory WHERE memory_id IN (...) AND city='Tokyo'
```

最终结果由 Memory Service 拼装返回。

---

# **3.4 写入流程（Write Flow）**

一条新 P5 记忆的写入过程如下：

```
用户上传图片
       ↓
vision.describe
       ↓
ontology.normalize
       ↓
embedding.generate → TES(930)
       ↓
Memory Service：
    1）写入 p5_memory 表
    2）写入向量库 index
```

写入必须保证：

- 两处写入均成功才算成功
- 任意一处失败 → 回滚

---

# **3.5 更新流程（Update Flow）**

例如用户编辑 sentiment 或 notes：

### 更新 sentiment：

```
1）重算 sentiment_scalar
2）重算 TES（embedding.generate）
3）更新 p5_memory 表中字段
4）更新向量库中的 tes_embedding
```

### 更新 notes：

```
只更新关系型数据库，不动向量库
```

---

# **3.6 删除流程（Delete Flow）**

```
DELETE FROM p5_memory WHERE memory_id=...
index.remove(memory_id)
```

必须级联删除向量库条目。

---

# **3.7 索引设计（Indexes）**

推荐建立以下数据库索引：

```
CREATE INDEX idx_user_id ON p5_memory(user_id);
CREATE INDEX idx_type ON p5_memory(type);
CREATE INDEX idx_timestamp ON p5_memory(timestamp);
CREATE INDEX idx_city ON p5_memory(city);
```

索引作用：

- 用户历史过滤
- 城市过滤（Planner 常用）
- 时间排序（挑最新体验）

---

# **3.8 存储容量规划（Sizing）**

930 维向量 \* float32 → 3720 bytes（约 3.7 KB）



---

# **3.9 小结（Summary）**

P5 Memory 的存储体系是：

```
结构化数据库（SQLite/Postgres）
       +
向量库（FAISS/Milvus）
```

二者配合实现：

- 高性能相似度检索
- 灵活过滤
- 可解释字段
- 易维护、易扩展

---
# P5 多模态记忆结构（P5 Memory Schema）— V1.0（续写 Part 4 起）

以下内容从 **第四部分** 开始写入，前面 1–3 部分你已单独保存，将在最终文档中自行拼接。

---

## **4. P5 的写入 / 更新 / 删除规则（Rules for Write / Update / Delete）**

P5 是 Taste Aligner 的“偏好数据库”，所有写入、更新、删除操作都必须保证：

- **原子性（Atomicity）**：要么全部成功，要么全部失败
- **一致性（Consistency）**：数据库与向量库永远同步
- **隔离性（Isolation）**：并发操作不互相污染
- **持久性（Durability）**：崩溃后可恢复

为此，P5 Memory 的写入 / 更新 / 删除遵循严格规则。

---

### **4.1 写入规则（Write Rules）**

写入流程必须严格按以下顺序执行：

```
Step 1: 从 embedding.generate 获取 TES(930)
Step 2: 写入 p5_memory（关系型数据库）
Step 3: 写入向量库 index（FAISS/Milvus）
Step 4: 返回成功状态
```

#### **4.1.1 两阶段提交（Two-Phase Commit）**

```
DB_ok AND Vector_ok → SUCCESS
否则 → 回滚所有写入
```

若任一子步骤失败：

- 若 DB 失败 → 中止写入
- 若 Vector 写入失败 → 回滚 DB 记录

#### **4.1.2 必填字段校验**

必须检查：

- memory\_id
- user\_id
- timestamp
- tes\_embedding（长度 = 930）

不满足 → Gateway 拦截。

---

### **4.2 更新规则（Update Rules）**

更新分为：

- **轻量更新（不动 TES）**
- **重计算更新（重新生成 TES）**

#### **4.2.1 轻量更新（Light Update）**

不影响 TES，也不更新向量库：

- notes（备注）
- source（来源）
- raw\_image（图片替换）

直接更新数据库字段即可。

#### **4.2.2 重计算更新（Heavy Update）**

以下情况必须重新生成 TES：

- sentiment 修改
- 标签体系更新
- 视觉 embedding 重算
- timestamp 被重置

流程：

```
embedding.generate → 新 TES
↓
更新 p5_memory 表
↓
更新向量库 tes_embedding
```

如重算失败：保留旧 TES。

---

### **4.3 删除规则（Delete Rules）**

删除必须确保数据库与向量库同步删除：

```
DELETE FROM p5_memory WHERE memory_id=...
vector_index.remove(memory_id)
```

#### **硬删除（Hard Delete）**

完全移除记录（默认模式）。

#### **软删除（Soft Delete）**

- source = "deleted"
- tes\_embedding = 全零向量
- 保留结构化字段用于审计或恢复

---

### **4.4 并发规则（Concurrency Rules）**

- 同一 memory\_id 的写入操作必须加行锁（Row Lock）
- 向量库更新需加排他锁（Exclusive Lock）避免读写冲突

---

### **4.5 版本管理（Versioning）**

每条 P5 记录带 version 字段：

- 当前：version = 1（对应 TES V1.0）
- 未来：TES V2.0 可平滑升级

旧数据补齐策略：

- 查询时若 version=1，则自动 pad 缺失维度

---

### **4.6 错误恢复（Failure Recovery）**

- DB 写入失败 → 中止，不写向量库
- Vector 写入失败 → 回滚 DB
- TES 更新失败 → 保留旧 tes\_embedding

错误日志需加入：`[MEMORY_WRITE_FAIL]`。

---

## **5. P5 Memory 在系统中的全流程流转（Lifecycle Flow）**

本节描述 P5 在 Taste Aligner 全链路中的生命周期，从“用户输入”到“推荐输出”的动态过程。

---

### **5.1 完整生命周期流程图（Lifecycle Overview）**

```
用户上传图片 / 输入文字
        ↓
Intent Agent
        ↓
Taste Analyzer Agent
        ① vision.describe
        ② ontology.normalize
        ③ embedding.generate → TES(930)
        ↓
Memory Service 写入 P5
        ↓
Matcher Agent 调用 memory.search（向量召回）
        ↓
Recommendation.score （CZ/EZ 得分）
        ↓
Planner Agent 生成旅程卡
```

流程说明：

- 用户每一次真实体验都会变成一条 P5 记忆单元
- P5 会反过来影响用户下一次推荐结果
- 系统始终保持“记忆 → 推断 → 输出”的闭环

---

### **5.2 P5 在各 Agent 中的作用**

#### **Intent Agent**

- 不直接使用 P5
- 负责识别 destination / task\_type

#### **Taste Analyzer Agent**

- 使用 P5 中的偏好标签 + 强偏好项构建初步 Taste Profile

#### **Matcher Agent**

- 使用 memory.search 的相似记忆（Memory Anchors）强化推荐权重

#### **Planner Agent**

- 使用 P5 为旅程卡绑定“记忆锚点”（突出用户个人故事感）

---

### **5.3 系统视角下的 P5 数据流**

```
[Raw Image / Tags / Sentiment]
            ↓
     (多模态处理)
vision.describe + ontology + embedding
            ↓
          [TES]
            ↓
      写入 P5 Memory
            ↓
 memory.search（相似度召回）
            ↓
 recommendation.score（决策）
            ↓
     planner.compose（旅程卡）
```

P5 Memory 是将“用户真实体验”转化为“可计算偏好”的关键节点。

---

## **5.4 小结（Summary）**

P5 的系统流转展示了一个闭环：

- 用户体验 → 生成记忆（P5）
- 记忆转化为数学表征（TES）
- TES 在推荐中发挥作用
- 推荐结果继续影响新的体验

Taste Aligner 就是在这个循环中不断变得“更懂用户”。

---

## **6. Memory Service API 设计（Memory Service API Design）**

本节定义 P5 Memory 在服务层（Memory Service）暴露给 Agent Runtime 与其他微服务的 **正式 API 接口规范**。 这些 API 是 Codex 未来生成 Memory Service 代码的蓝本，必须结构稳定、字段固定、无歧义。

Memory Service 的主要职责：

- 写入 P5（Add）
- 获取 P5（Get）
- 搜索 P5（Search）
- 更新 P5（Update）
- 删除 P5（Delete）

所有 API 必须：

- 使用 JSON 作为通信格式
- 表结构与 P5 Schema 完全一致
- 与 Gateway／Agent 配合

---

# **6.1 API 总览（API Overview）**

| 功能    | 方法   | 路径               | 描述                       |
| ----- | ---- | ---------------- | ------------------------ |
| 写入 P5 | POST | `/memory/add`    | 写入一条新记忆单元                |
| 获取 P5 | GET  | `/memory/get`    | 根据 memory\_id 读取         |
| 检索 P5 | POST | `/memory/search` | 向量相似度召回 + 结构化过滤          |
| 更新 P5 | POST | `/memory/update` | 更新 sentiment / notes 等字段 |
| 删除 P5 | POST | `/memory/delete` | 删除数据库与向量库记录              |

所有 API 均返回：`{ status, data, error }` 三段式结构。

---

# **6.2 /memory/add（写入记忆）**

### **方法：POST**

### **路径：\*\*\*\*\*\*\*\***``

### **请求体（Request Body）**

```
{
  "memory_id": string,
  "user_id": string,
  "type": "food" | "scenery",

  "raw_image": string | null,
  "image_embedding": number[] | null,
  "raw_labels": string[],
  "normalized_labels": string[],
  "style_tags": string[] | null,

  "sentiment": number,
  "timestamp": string,
  "location": {
      "city": string | null,
      "country": string | null
  },

  "tes_embedding": number[],
  "source": string,
  "notes": string | null,
  "version": number
}
```

### **返回（Response）**

```
{
  "status": "success",
  "data": { "memory_id": string }
}
```

### **错误码（Error Codes）**

- `MEMORY_WRITE_FAIL`
- `VECTOR_WRITE_FAIL`
- `BAD_SCHEMA`

---

# **6.3 /memory/get（读取记忆）**

### **方法：GET**

### **路径：\*\*\*\*\*\*\*\***``

### **返回（Response）**

```
{
  "status": "success",
  "data": { P5_Memory_Unit }
}
```

### **错误码**

- `MEMORY_NOT_FOUND`

---

# **6.4 /memory/search（检索记忆）**

### **方法：POST**

### **路径：\*\*\*\*\*\*\*\***``

### **请求体（Request Body）**

```
{
  "query_vector": number[],     // TES query
  "top_k": number,
  "filters": {
      "type": "food" | "scenery" | null,
      "city": string | null
  }
}
```

### **返回（Response）**

```
{
  "status": "success",
  "data": [
      {
        "memory_id": string,
        "score": number,
        "type": string,
        "normalized_labels": string[],
        "sentiment": number,
        "location": {
            "city": string,
            "country": string
        },
        "timestamp": string,
        "raw_image": string
      }
  ]
}
```

### **错误码**

- `VECTOR_SEARCH_FAIL`
- `EMPTY_QUERY`

---

# **6.5 /memory/update（更新记忆）**

### **方法：POST**

### **路径：\*\*\*\*\*\*\*\***``

### **请求体（Request Body）**

```
{
  "memory_id": string,
  "fields": {
      "sentiment": number | null,
      "notes": string | null,
      "raw_image": string | null,
      "timestamp": string | null
  }
}
```

### **更新逻辑说明**

- 若修改 sentiment → 触发 TES 重计算
- 若修改 notes → 仅更新 DB
- 若修改 timestamp → 更新 recency → TES 重算

### **返回（Response）**

```
{
  "status": "success",
  "data": { "memory_id": string }
}
```

### **错误码**

- `MEMORY_UPDATE_FAIL`
- `TES_RECALC_FAIL`

---

# **6.6 /memory/delete（删除记忆）**

### **方法：POST**

### **路径：\*\*\*\*\*\*\*\***``

### **请求体（Request Body）**

```
{
  "memory_id": string,
  "mode": "hard" | "soft"
}
```

### **返回（Response）**

```
{
  "status": "success",
  "data": { "deleted": true }
}
```

### **错误码**

- `MEMORY_DELETE_FAIL`
- `VECTOR_DELETE_FAIL`

---

## **6.7 小结（Summary）**

Memory Service API 设计完备定义：

- 所有写入、查询、检索、更新、删除行为
- 全量 JSON Schema
- 错误码规范
- Gateway/Agent 可直接调用

---

## **7. Memory Service 与 Gateway 的交互协议（Gateway ↔ Memory Service Interaction Protocol）**

本节定义 **Gateway（Java）** 与 **Memory Service（Python/Node）** 之间的正式交互标准。\
此规范将用于：

- Codex 生成 Gateway 层（工具调用代理）
- 生成 Memory Service 的 HTTP 接口
- 保证 ReAct 工具调用链的稳定性与可调试性

Gateway 是所有工具（Tool）调用的入口，因此必须确保：

- Schema 校验一致
- Header 注入 trace\_id
- 返回格式稳定
- 错误码转换统一

本节是 Taste Aligner 多服务协作的“粘合层（Glue Layer）”。

---

# **7.1 通信方式（Transport Layer）**

Gateway 与 Memory Service 采用：

- **HTTP/1.1 或 HTTP/2**（推荐）
- **JSON 作为消息格式**
- **POST 用于所有会修改数据的操作**
- **GET 仅用于读取操作**

---

# **7.2 Header 规范（Headers）**

每一次 Gateway → Memory Service 的请求必须附带：

```
X-Trace-Id: <全局 trace_id>
X-Service-Caller: gateway
Content-Type: application/json
```

其中：

- **X-Trace-Id**：用于全链路日志追踪
- **X-Service-Caller**：未来可用于访问权限管控

Memory Service 返回的数据也必须包含 trace\_id：

```
X-Trace-Id: <same_id>
```

---

# **7.3 Schema 校验（Schema Validation）**

Gateway 负责：

- 校验所有请求 body 必须符合 JSON Schema
- 校验字段与 tool\_registry\_cn / tool\_registry\_en 一致
- 禁止多余字段（extra fields）进入后端

如果校验失败：

```
{ "error": true, "code": "BAD_SCHEMA", "message": ... }
```

并不会把请求转发到 Memory Service。

### 7.3.1 校验内容包括：

- Required 字段是否存在
- 类型是否正确
- TES embedding 长度是否为 930
- mode 字段是否与规范一致（memory/search/update/delete）

---

# **7.4 调用格式（Gateway → Memory Service Request Format）**

所有 Gateway 调用必须包装成统一结构：

```
{
  "payload": { ... },       // 工具 Input
  "trace_id": string,       // 全局 trace
  "tool": "memory.add"    // 工具名
}
```

Memory Service 不需要解析工具名，只需关注 payload。

---

# **7.5 返回格式（Memory Service → Gateway Response）**

Memory Service 必须返回统一结构：

```
{
  "status": "success" | "error",
  "data": { ... },          // 成功时有
  "error": {                 // 失败时有
      "code": string,
      "message": string
  },
  "trace_id": string
}
```

Gateway 会将此结果转化为：

- Observation（当成功）
- 错误 Observation（当失败）

---

# **7.6 错误码映射（Error Code Mapping）**

Gateway 会把 Memory Service 的错误码映射到 ReAct 工具规范：

| Memory Error         | Gateway 转换后          | 工具内表现                  |
| -------------------- | -------------------- | ---------------------- |
| MEMORY\_NOT\_FOUND   | MEMORY\_NOT\_FOUND   | Observation.error=true |
| BAD\_SCHEMA          | BAD\_SCHEMA          | Observation.error=true |
| VECTOR\_SEARCH\_FAIL | VECTOR\_SEARCH\_FAIL | Observation.error=true |
| TES\_RECALC\_FAIL    | TES\_RECALC\_FAIL    | Observation.error=true |
| MEMORY\_WRITE\_FAIL  | INTERNAL\_ERROR      | Observation.error=true |

所有错误最终都必须转化为：

```
Observation: {"error": true, "code": "...", "message": "..."}
```

---

# **7.7 超时、重试与熔断机制（Timeout / Retry / Circuit Breaker）**

Gateway 必须具备基础流控能力：

### **7.7.1 超时（Timeout）**

- Memory Service 单次调用超时：**1.5s**（可配置）
- 超时后 → retry 一次

### **7.7.2 重试（Retry）**

```
retry_count = 1
```

若仍失败 → 返回错误 Observation

### **7.7.3 熔断（Circuit Breaker）**

若 Memory Service 出现连续 N 次（默认 5）失败：

- Gateway 启动熔断：**暂停调用 10 秒**
- 期间所有请求直接返回：`SERVICE_UNAVAILABLE`

---

# **7.8 日志与可观测性（Logging & Observability）**

Gateway 必须对每一次 Memory 调用写入日志：

```
[GATEWAY] tool=memory.add | trace=<id> | latency=<ms> | status=<success/error>
```

Memory Service 必须写入：

```
[SERVICE] name=memory | trace=<id> | route=<path> | latency=<ms>
```

日志功能用于：

- 性能分析（latency heatmap）
- 错误定位（trace\_id）
- Gateway ↔ Service 的调试

---

# **7.9 安全性（Security）**

- 禁止未经 Schema 校验的字段到达 Memory Service
- 禁止用户输入覆盖数据库字段（如 version）
- 所有 JSON 必须由 Gateway 清洗才能下发
- 不允许 Memory Service 再调用其他外部网络

---

## **7.10 小结（Summary）**

Gateway ↔ Memory Service 的交互协议确保：

- 工具调用链路统一
- Schema 绝对一致
- 错误处理稳定
- 可观测性可用
- Codex 能基于该协议生成可靠的 Gateway 与后端代码

