# Recommendation Service Data Import

## Import `data.txt` into SQLite

From repo root:

```bash
python3 services/recommendation/scripts/import_data_txt.py
```

What it does:
- Reads `services/recommendation/data/data.txt`
- Ensures schema/table/indexes for `reco_items`
- Normalizes fields and performs idempotent upsert by `item_id`
- Validates city totals/type counts with reasonable ranges before writing (target mismatch only warns)

## Verify DB distribution

From repo root:

```bash
python3 services/recommendation/scripts/verify_db.py
```

Expected output shape:
- `total items`
- `total cities`
- per-city counts (`total`, `food`, `culture`, `walk`)
- list of cities not equal to 50 items (informational)
- list of cities that deviate from target `food=22, culture=18, walk=10` (informational)
- list of cities outside reasonable ranges (blocking)

Exit code:
- `0` when DB is non-empty and all cities are in reasonable ranges
- non-zero when DB is empty or any city is outside reasonable ranges
