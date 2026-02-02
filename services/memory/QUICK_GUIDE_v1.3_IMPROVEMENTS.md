# Memory v1.3 工程改进 - 快速使用指南

## 改进 1: 测试数据重置

### 一行命令清空数据库

```bash
curl -X POST http://localhost:5001/debug/reset
```

**返回示例：**
```json
{
  "ok": true,
  "deleted_count": 42,
  "remaining_count": 0,
  "warning": "All memories deleted - DEVELOPMENT ONLY"
}
```

### 配合测试使用

```bash
# 重置 + 运行原有测试
curl -X POST http://localhost:5001/debug/reset && ./test_v1_3.sh

# 重置 + 运行余弦方差测试
curl -X POST http://localhost:5001/debug/reset && ./test_cosine_variance.sh
```

---

## 改进 2: 余弦方差验证测试

### 自动化运行（推荐）

```bash
./test_cosine_variance.sh
```

这个脚本会：
1. 自动调用重置端点清理数据
2. 运行余弦方差验证测试
3. 显示详细的分数分解

### 手动运行

```bash
# 步骤 1: 重置数据
curl -X POST http://localhost:5001/debug/reset

# 步骤 2: 运行测试
python3 test_cosine_variance.py
```

---

## 完整测试流程

```bash
# 1. 确保 Memory Service 运行中
cd services/memory
python3 main.py &

# 2. 等待服务启动
sleep 2

# 3. 运行所有测试
echo "=== 运行原有 v1.3 测试 ==="
./test_v1_3.sh

echo ""
echo "=== 运行余弦方差测试 ==="
./test_cosine_variance.sh

# 4. 查看服务健康状态
curl http://localhost:5001/health | python3 -m json.tool
```

---

## 典型输出示例

### 重置端点输出

```bash
$ curl -X POST http://localhost:5001/debug/reset
{
    "ok": true,
    "deleted_count": 7,
    "remaining_count": 0,
    "warning": "All memories deleted - DEVELOPMENT ONLY"
}
```

### 余弦方差测试输出（摘要）

```
======================================================================
Memory Service v1.3 - Cosine Variance Validation
======================================================================

Step 0: Verify embedding cosine similarities
----------------------------------------------------------------------
  Query vs High-similarity embedding:   cosine = 0.995123
  Query vs Medium-similarity embedding: cosine = 0.851234
  Query vs Low-similarity embedding:    cosine = 0.701234

  → Embeddings have meaningful differences ✓

...

Actual Results:

1. mem_med_cos_recent
   Final Score: 0.912345
   ├─ cosine:    0.850000  ← Similarity to query
   ├─ w_time:    0.941765  ← Time decay (exp(-0.03 * Δdays))
   ├─ w_sent:    1.400000  ← Sentiment (1 + 0.5 * sentiment)
   └─ w_context: 1.320000  ← Context (city * tag)
   Formula: 0.912345 = 0.850000 × 0.941765 × 1.400000 × 1.320000

...

Key Insights:

  1. Cosine similarity is NOT the only ranking factor
     → System correctly balances similarity with recency

  2. Time decay has strong influence
     → 30-day-old memory gets ~60% penalty (w_time ≈ 0.41)

  3. Final ranking reflects TRADEOFF between:
     • Semantic similarity (cosine)
     • Temporal relevance (w_time)
     • Emotional valence (w_sent)
     • Contextual match (w_context)

✓ Cosine variance validation complete!
✓ System correctly balances similarity with other factors
```

---

## 快速命令参考

| 任务 | 命令 |
|------|------|
| 清空测试数据 | `curl -X POST http://localhost:5001/debug/reset` |
| 运行原有测试 | `./test_v1_3.sh` |
| 运行余弦方差测试 | `./test_cosine_variance.sh` |
| 查看服务状态 | `curl http://localhost:5001/health` |
| 手动余弦测试 | `python3 test_cosine_variance.py` |

---

## 注意事项

⚠️ **重置端点仅用于开发环境**
- 不要在生产环境暴露 `/debug/reset`
- 此端点会**永久删除**所有记忆数据
- 删除操作**不可逆**

✅ **测试最佳实践**
- 每次测试前先重置数据，确保干净环境
- 使用提供的 `.sh` 脚本自动化测试流程
- 检查测试输出中的分数分解，理解排序逻辑

---

详细文档请参考：[ENGINEERING_IMPROVEMENTS_v1.3.md](ENGINEERING_IMPROVEMENTS_v1.3.md)
