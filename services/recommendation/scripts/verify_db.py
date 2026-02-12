#!/usr/bin/env python3
"""Verify reco_items quality and distribution in SQLite."""

from __future__ import annotations

import sqlite3
from collections import defaultdict
from pathlib import Path

TARGET_TOTAL_PER_CITY = 50
TARGET_TYPE_COUNTS = {"food": 22, "culture": 18, "walk": 10}
REASONABLE_RANGES = {
    "total": (45, 55),
    "food": (18, 26),
    "culture": (14, 22),
    "walk": (8, 14),
}


def main() -> None:
    service_root = Path(__file__).resolve().parents[1]
    db_path = service_root / "data" / "reco.db"
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    try:
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='reco_items'"
        ).fetchone()
        if not table_exists:
            print(f"Validation failed: table reco_items not found in {db_path}")
            raise SystemExit(1)

        total_items = conn.execute("SELECT COUNT(*) AS c FROM reco_items").fetchone()["c"]
        total_cities = conn.execute("SELECT COUNT(DISTINCT city) AS c FROM reco_items").fetchone()["c"]

        rows = conn.execute(
            "SELECT city, type, COUNT(*) AS c FROM reco_items GROUP BY city, type ORDER BY city, type"
        ).fetchall()
        per_city = defaultdict(lambda: {"food": 0, "culture": 0, "walk": 0, "total": 0})
        for row in rows:
            city = row["city"]
            item_type = row["type"]
            count = int(row["c"])
            if item_type in {"food", "culture", "walk"}:
                per_city[city][item_type] = count
            per_city[city]["total"] += count

        print(f"DB: {db_path}")
        print(f"total items: {total_items}")
        print(f"total cities: {total_cities}")
        print("per-city distribution:")
        for city in sorted(per_city):
            c = per_city[city]
            print(
                f"  - {city}: total={c['total']}, food={c['food']}, culture={c['culture']}, walk={c['walk']}"
            )

        bad_total = []
        bad_type = []
        out_of_range = []
        for city in sorted(per_city):
            c = per_city[city]
            if c["total"] != TARGET_TOTAL_PER_CITY:
                bad_total.append(city)
            if (
                c["food"] != TARGET_TYPE_COUNTS["food"]
                or c["culture"] != TARGET_TYPE_COUNTS["culture"]
                or c["walk"] != TARGET_TYPE_COUNTS["walk"]
            ):
                bad_type.append(city)
            if not (
                REASONABLE_RANGES["total"][0] <= c["total"] <= REASONABLE_RANGES["total"][1]
                and REASONABLE_RANGES["food"][0] <= c["food"] <= REASONABLE_RANGES["food"][1]
                and REASONABLE_RANGES["culture"][0] <= c["culture"] <= REASONABLE_RANGES["culture"][1]
                and REASONABLE_RANGES["walk"][0] <= c["walk"] <= REASONABLE_RANGES["walk"][1]
            ):
                out_of_range.append(city)

        print("cities not equal to 50 items:")
        if bad_total:
            for city in bad_total:
                c = per_city[city]
                print(f"  - {city}: total={c['total']}")
        else:
            print("  - none")

        print("cities deviating from target type counts 22/18/10:")
        if bad_type:
            for city in bad_type:
                c = per_city[city]
                print(
                    f"  - {city}: food={c['food']} culture={c['culture']} walk={c['walk']}"
                )
        else:
            print("  - none")

        print(
            "cities outside reasonable ranges "
            f"(total={REASONABLE_RANGES['total']}, "
            f"food={REASONABLE_RANGES['food']}, "
            f"culture={REASONABLE_RANGES['culture']}, "
            f"walk={REASONABLE_RANGES['walk']}):"
        )
        if out_of_range:
            for city in out_of_range:
                c = per_city[city]
                print(
                    f"  - {city}: total={c['total']} food={c['food']} culture={c['culture']} walk={c['walk']}"
                )
        else:
            print("  - none")

        if total_items == 0 or total_cities == 0 or out_of_range:
            raise SystemExit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
