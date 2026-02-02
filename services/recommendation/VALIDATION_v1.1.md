# Recommendation Service v1.1 - Validation Commands

## Prerequisites

### 1. Start Memory Service (Required for memory_influence)

```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/memory
python3 main.py
```

Service should be running on `http://localhost:5001`

### 2. Start Recommendation Service v1.1

```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/recommendation
python3 main.py
```

Service should be running on `http://localhost:5005`

---

## Acceptance Tests

### A) Recommendation Health Check

**Command:**
```bash
curl http://localhost:5005/health | python3 -m json.tool
```

**Expected Output:**
```json
{
    "ok": true,
    "service": "recommendation",
    "version": "v1.1",
    "dataset_source": "sqlite",
    "total_items": 33,
    "total_cities": 3,
    "city_distribution": {
        "milan": 11,
        "paris": 11,
        "tokyo": 11
    },
    "db_path": "..."
}
```

**Validation:** Confirms SQLite database is loaded and accessible.

---

### B) tags=[] → EZ Must Not Be Empty

**Test:** When tags are empty, EZ should still return results (excellence fallback).

**Command:**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_empty_tags",
      "city": "tokyo",
      "tags": []
    }
  }' | python3 -m json.tool
```

**Validation:**
1. Check `ez_ranked` array: should have **length >= 5**
2. Check `recall.ez_candidates`: should be > 0
3. All EZ items should have `excellence >= 0.8`

**Quick Check (using jq):**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test_user","city":"tokyo","tags":[]}}' -s \
  | jq '.ez_ranked | length'
```

**Expected:** `>= 5`

---

### C) CZ Same-City Only

**Test:** CZ candidates must ALL be from the same city as the request.

**Command:**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_cz_city",
      "city": "tokyo",
      "tags": ["ramen", "walk", "nightlife"]
    }
  }' | python3 -m json.tool
```

**Validation:**
1. Check all items in `cz_ranked`: **city MUST be "tokyo"**
2. No cross-city items in CZ

**Quick Check (using jq):**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' -s \
  | jq '.cz_ranked[] | .city' | sort | uniq
```

**Expected:** Only `"tokyo"` should appear

---

### D) memory_influence Variance

**Test:** memory_influence should be item-dependent, not constant.

**Command:**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_memory_var",
      "city": "tokyo",
      "tags": ["ramen", "japanese"]
    }
  }' | python3 -m json.tool
```

**Validation:**
1. At least 3 items in `cz_ranked` should have **different** `components.memory_influence` values
2. Check `memory_influence_detail.method`: should NOT be "fallback_*" for all items
3. Check `anchor_memory_ids`: should be populated

**Quick Check (using jq):**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' -s \
  | jq '[.cz_ranked[0:5][] | .components.memory_influence] | unique | length'
```

**Expected:** `>= 3` (at least 3 distinct values in top 5)

**Detailed Check:**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' -s \
  | jq '.cz_ranked[0:5][] | {id: .id, memory_influence: .components.memory_influence, method: .memory_influence_detail.method}'
```

---

### E) Intent Affects Ratio (comfort vs explore)

**Test 1: Intent = "comfort"**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_intent",
      "city": "tokyo",
      "tags": ["ramen"],
      "intent": "comfort",
      "memory_confidence": 0.8
    }
  }' -s | jq '.mix_policy | {ratio, rule, inputs_used}'
```

**Expected:** Ratio should favor CZ (e.g., "3:0", "3:1", or "2:1")

**Test 2: Intent = "explore"**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_intent",
      "city": "tokyo",
      "tags": ["ramen"],
      "intent": "explore",
      "memory_confidence": 0.8
    }
  }' -s | jq '.mix_policy | {ratio, rule, inputs_used}'
```

**Expected:** Ratio should favor EZ (e.g., "1:2", "1:3", or "1:1")

**Validation:**
- Different `intent` values should produce **different ratios**
- `mix_policy.inputs_used.intent` should match request

---

### F) Memory Confidence Affects Ratio

**Test 1: High Confidence (0.9)**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_conf",
      "city": "tokyo",
      "tags": ["ramen"],
      "intent": "comfort",
      "memory_confidence": 0.9
    }
  }' -s | jq '.mix_policy | {ratio, rule, confidence, inputs_used}'
```

**Expected:** High memory_confidence with intent="comfort" → strong CZ ratio (e.g., "3:0")

**Test 2: Low Confidence (0.2)**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_conf",
      "city": "tokyo",
      "tags": ["ramen"],
      "intent": "comfort",
      "memory_confidence": 0.2
    }
  }' -s | jq '.mix_policy | {ratio, rule, confidence, inputs_used}'
```

**Expected:** Low memory_confidence → more cautious ratio (e.g., "2:1")

**Validation:**
- Different `memory_confidence` values should produce **different ratios** (given same intent)

---

### G) EZ Taste Distance Check

**Test:** EZ items should have meaningful taste_distance values.

**Command:**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user_ez",
      "city": "tokyo",
      "tags": ["ramen", "japanese"]
    }
  }' -s | jq '.ez_ranked[0:5][] | {id, taste_distance: .components.taste_distance, taste_similarity_raw: .components.taste_similarity_raw, taste_similarity_capped: .components.taste_similarity_capped}'
```

**Validation:**
1. `taste_distance` should vary across items (not all the same)
2. If `taste_similarity_raw > 0.7`, then `taste_similarity_capped == 0.7`
3. `taste_distance = 1 - taste_similarity_capped`

**Average Taste Distance (EZ vs CZ):**
```bash
# EZ average
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' -s \
  | jq '[.ez_ranked[] | .components.taste_distance] | add / length'

# CZ average (for comparison - CZ doesn't have taste_distance, use 1-tag_similarity)
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' -s \
  | jq '[.cz_ranked[] | (1 - .components.tag_similarity)] | add / length'
```

**Expected:** EZ average taste_distance should be **>= 0.2 higher** than CZ

---

## Full Integration Test

**Command:**
```bash
curl -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "integration_test_user",
      "city": "tokyo",
      "tags": ["ramen", "nightlife", "walk"],
      "intent": "balanced",
      "memory_confidence": 0.7
    }
  }' | python3 -m json.tool > /tmp/reco_v1_1_test.json

cat /tmp/reco_v1_1_test.json | jq '{
  version: .debug.dataset_source,
  recall: {
    cz: .recall.cz_candidates,
    ez: .recall.ez_candidates
  },
  cz_count: (.cz_ranked | length),
  ez_count: (.ez_ranked | length),
  mix_policy: .mix_policy.ratio,
  cz_cities: [.cz_ranked[] | .city] | unique,
  sample_cz_memory_influences: [.cz_ranked[0:3][] | .components.memory_influence],
  sample_ez_taste_distances: [.ez_ranked[0:3][] | .components.taste_distance]
}'
```

**Expected Output:**
```json
{
  "version": "sqlite",
  "recall": {
    "cz": 11,
    "ez": 18
  },
  "cz_count": 10,
  "ez_count": 5,
  "mix_policy": "2:1",
  "cz_cities": ["tokyo"],
  "sample_cz_memory_influences": [1.2, 0.8, 1.1],
  "sample_ez_taste_distances": [0.4, 0.5, 0.3]
}
```

**Validation Checklist:**
- [ ] `version == "sqlite"`
- [ ] `cz_cities` contains ONLY the request city
- [ ] `sample_cz_memory_influences` has distinct values
- [ ] `sample_ez_taste_distances` has meaningful variance

---

## Service Startup Commands

### Memory Service
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/memory
python3 main.py
```

### Recommendation Service v1.1
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner/services/recommendation
python3 main.py
```

### Re-seed Database (if needed)
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner
python3 scripts/seed_reco_db.py
```

---

## Quick Acceptance Checklist

Run these commands to verify all v1.1 requirements:

```bash
# A) Health check
curl -s http://localhost:5005/health | jq '.version, .dataset_source, .total_items'

# B) EZ not empty when tags=[]
curl -s -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":[]}}' \
  | jq '.ez_ranked | length'
# Expected: >= 5

# C) CZ same-city only
curl -s -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' \
  | jq '.cz_ranked[] | .city' | sort | uniq
# Expected: Only "tokyo"

# D) memory_influence variance
curl -s -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"]}}' \
  | jq '[.cz_ranked[0:5][] | .components.memory_influence] | unique | length'
# Expected: >= 3

# E) Intent affects ratio
curl -s -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"],"intent":"comfort","memory_confidence":0.8}}' \
  | jq '.mix_policy.ratio'
# Expected: CZ-heavy (e.g., "3:0", "3:1")

curl -s -X POST http://localhost:5005/score \
  -H "Content-Type: application/json" \
  -d '{"data":{"user_id":"test","city":"tokyo","tags":["ramen"],"intent":"explore","memory_confidence":0.8}}' \
  | jq '.mix_policy.ratio'
# Expected: EZ-heavy (e.g., "1:2", "1:3")
```

---

## Troubleshooting

### Issue: Memory Service not responding

**Symptom:** All `memory_influence_detail.method` show "fallback_error"

**Solution:**
1. Check Memory Service is running: `curl http://localhost:5001/health`
2. Check logs for timeout errors
3. Verify Memory Service has data (write some test memories first)

### Issue: Database not found

**Symptom:** Health check returns error about database

**Solution:**
```bash
cd /Volumes/leong4/University_doc/RAG/Taste-Aligner/Taste_Aligner
python3 scripts/seed_reco_db.py
```

### Issue: No EZ results

**Symptom:** `ez_ranked` is empty

**Solution:** Check that database has items with `excellence >= 0.8`:
```bash
sqlite3 services/recommendation/data/reco.db "SELECT COUNT(*) FROM items WHERE excellence >= 0.8;"
```

---

## Success Criteria Summary

| Test | Requirement | Check Command |
|------|-------------|---------------|
| A | Service health | `curl http://localhost:5005/health` |
| B | EZ not empty (tags=[]) | `jq '.ez_ranked \| length'` >= 5 |
| C | CZ city-only | `jq '.cz_ranked[].city'` all same |
| D | memory_influence variance | `jq unique \| length` >= 3 |
| E | Intent affects ratio | Different ratios for comfort/explore |
| F | Memory confidence affects ratio | Different ratios for 0.9/0.2 |
| G | EZ taste_distance meaningful | Average EZ distance > CZ distance |

**All tests must pass for v1.1 acceptance.**
