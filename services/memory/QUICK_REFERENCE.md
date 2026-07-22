# Memory Service v1.3 - Quick Reference

## Scoring Formula

```
final_score = cosine_similarity × w_time × w_sent × w_context
```

## Weighting Factors

### v1.1 - Time Decay (w_time)
```python
w_time = exp(-0.03 × Δdays)
```
- Recent (1 day): ≈ 0.97
- Mid (30 days): ≈ 0.41
- Old (100 days): ≈ 0.05

### v1.2 - Sentiment Weight (w_sent)
```python
w_sent = 1 + 0.5 × sentiment × sentiment_confidence
# Clamped to [0.5, 1.5]
```
Memory persists canonical signed sentiment in `[-1, 1]` with
`sentiment_scale="signed_v1"`: `-1` is very negative, `0` is neutral, and `1`
is very positive. Caption analysis writes `sentiment_source`,
`sentiment_confidence`, and `sentiment_available`. Missing or unavailable
analysis always uses `w_sent=1.0` and is not represented as measured neutral.

- Positive (+0.8): 1.4
- Neutral (0.0): 1.0
- Negative (-0.5): 0.75

### v1.3 - Context Boost (w_context)
```python
w_context = city_boost × tag_boost

city_boost = 1.2 if city match else 1.0
tag_boost = 1.1 if tag overlap ≥ 1 else 1.0
```
- Both match: 1.32
- City only: 1.2
- Tag only: 1.1
- No match: 1.0

## Test Commands

```bash
# Run validation tests
python3 test_v1_3.py

# Check health
curl http://localhost:5001/health

# Search example
curl -X POST http://localhost:5001/search \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "user_id": "test_user",
      "query_embedding": [...],
      "query_tags": ["ramen"],
      "city": "tokyo",
      "now_ts": "2026-01-31T00:00:00Z",
      "top_k": 10
    }
  }'
```

## Response Format

Each search result includes full explainability:

```json
{
  "memory_id": "...",
  "score": 1.793383,
  "cosine": 1.0,
  "w_time": 0.970446,
  "w_sent": 1.4,
  "w_context": 1.32,
  "city_boost": 1.2,
  "tag_boost": 1.1,
  "timestamp": "2026-01-30T00:00:00Z",
  "city": "tokyo",
  "normalized_tags": ["ramen"],
  "sentiment": 0.8,
  "sentiment_confidence": 0.9,
  "sentiment_available": true,
  "sentiment_source": "caption_lexicon_v1"
}
```

`POST /write` is idempotent when the caller supplies `memory_id`: a repeat by
the same user returns HTTP 200 with `idempotent_replay=true`; a different-user
collision returns HTTP 409.

## Files Modified

- `search.py` - Updated weighting logic
- `main.py` - Fixed imports for standalone running
- `test_v1_3.py` - Comprehensive validation tests
- `UPGRADE_v1.3_CN.md` - Detailed Chinese explanation

## Migration Path to Chroma/FAISS

1. **Phase 1 (Current)**: SQLite + Python weighting
2. **Phase 2**: Chroma ANN search + Python re-ranking
3. **Phase 3**: Optimized hybrid search

Weighting functions are storage-agnostic and will work unchanged with Chroma.
