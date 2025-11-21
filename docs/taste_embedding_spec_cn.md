# Taste Embedding Space (TES) Specification — V1.0

本文件定义 Taste Aligner V10 的统一向量空间 **TES（Taste Embedding Space）** 的组成结构、各部分维度、数学意义及用途。

该文档将被以下模块引用：
- Embedding Service（embedding.generate）
- Memory Service（P5 多模态记忆）
- Recommendation Engine（CZ/EZ 排序）
- Gateway Schema 校验
- Agent Runtime（构建 query embedding）

---

# **1. TES 目标（Purpose）**
TES 是 Taste Aligner 的核心表征向量，用于描述：
- 用户的品味偏好（Taste Profile）
- 记忆单元（P5 Memory）的多模态特征
- 用于 query → candidate 的相似度计算

TES 必须：
- 维度固定
- 可由任意输入组合生成
- 可解释且可调试
- 支持 image + tag + sentiment + recency + location

---

# **2. TES 组件（Components）**
TES 由六种组件拼接（concat）构成，分别来自视觉、语义、风格、情绪、时间、地点六个方向的偏好信息。

| 组件 Component | 维度 Dim | 说明 Description |
|----------------|-----------|------------------|
| visual (vision_embedding) | **512** | 来自 vision.describe 的 CLIP/视觉向量 |
| tags (tag_embedding) | **384** | 语义标签 embedding（多标签池化） |
| style (style_embedding) | **16** | 视觉风格 / 美学 embedding（如 cozy, analog, bright） |
| sentiment (sentiment_scalar) | **1** | 用户对该项目的情感强度（[-1,1]） |
| recency (recency_scalar) | **1** | 基于时间的新鲜度衰减值 |
| location (location_embedding) | **16** | 地点（城市/国家）embedding |
| **Total（最终 TES 维度）** | **930** | 上述六部分 concat 后的向量 |

---

# **3. 组件细节说明（Detail Explanation）**

## **3.1 Visual Embedding — 512 dim**
来源：vision.describe

特点：
- 视觉主体信息（食物/景点）
- 构图、形状、纹理
- 对推荐影响最大

模型建议：CLIP / SigLip / OpenCLIP

---

## **3.2 Tag Embedding — 384 dim**
来源：ontology.normalize → tag dictionary

处理方式：
- 多标签 → embedding → mean/max pooling

优势：
- 轻量
- 可扩展（标签体系可不断增长）

---

## **3.3 Style Embedding — 16 dim**
来源：vision.describe → style_tags

包含：
- 色调（warm/cold）
- 氛围（cozy/minimal/elegant）
- 饱和度、光照
- 审美气质（analog/digital）

用途：
- 实现“审美偏好”的个性化推荐
- 区分同类项目的不同气质

---

## **3.4 Sentiment Scalar — 1 dim**
来源：embedding.generate 的 sentiment 参数

值域：[-1, 1]

含义：
- 反映用户喜好强度
- 轻量、对召回排序影响显著

---

## **3.5 Recency Scalar — 1 dim**
公式示例：
```
recency = exp(- days / 90)
```

用途：
- 越新的记忆，权重越高
- 防止老数据主导推荐

---

## **3.6 Location Embedding — 16 dim**
来源：城市/国家编码

用途：
- 未来支持跨城市推荐增强
- 用户对地点的偏好模式

---

# **4. 最终 TES（930 维）结构图**
```
[ visual(512) ]
       ⊕
[ tags(384) ]
       ⊕
[ style(16) ]
       ⊕
[ sentiment(1) ]
       ⊕
[ recency(1) ]
       ⊕
[ location(16) ]
--------------------------------------------
               = 930 dim
```

---

# **5. 与系统的接口（Integration Points）**
TES 将用于以下模块：

### **5.1 Embedding Service**
- 输入：视觉 / 标签 / 情绪 / 时间 / 地点
- 输出：930 维向量

### **5.2 Memory Service（P5 Memory）**
- 每条记忆都存一个 TES
- 用作用户偏好建模

### **5.3 Recommendation Engine**
- user_embedding 与 item_embedding 点积 / 余弦相似度

### **5.4 Gateway Schema 校验**
- 检查维度是否一致

### **5.5 Agent Runtime（query 构建）**
- 用户输入 → 930 维向量

---

# **6. 未来可升级版本（TES V2.0 计划）**
未来可以加入：
- 情感 embedding（8~16 维）
- 风格 embedding 扩展为 32 维
- 地点 embedding 编码更多层次（街区/热度）
- 加入主题偏好 embedding（如艺术/咖啡/自然）

V1.0 的结构允许未来无痛升级。

---

（文件结束 End of TES Spec V1.0）

