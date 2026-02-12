#!/usr/bin/env python3
"""Import recommendation items from data.txt into SQLite reco_items."""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional

TARGET_TOTAL_PER_CITY = 50
TARGET_TYPE_COUNTS = {"food": 22, "culture": 18, "walk": 10}
REASONABLE_RANGES = {
    "total": (45, 55),
    "food": (18, 26),
    "culture": (14, 22),
    "walk": (8, 14),
}
VALID_TYPES = {"food", "culture", "walk"}
TYPE_ALIASES = {"ure": "culture", "ture": "culture", "k": "walk"}
GENERIC_FOOD_DENYLIST = {
    "ramen",
    "sushi",
    "pizza",
    "burger",
    "taco",
    "tacos",
    "pasta",
    "noodles",
    "hotpot",
    "dumplings",
}


@dataclass
class ParsedItem:
    item_id: Optional[str]
    city: str
    item_type: str
    title: str
    tags: List[str]
    excellence: float
    description: Optional[str]
    source: str


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def normalize_city(raw: str) -> str:
    return re.sub(r"\s+", " ", raw).strip().lower()


def normalize_title(raw: str) -> str:
    title = re.sub(r"\s+", " ", raw).strip(" \t\r\n-•*")
    return title


def normalize_tags(raw: str) -> List[str]:
    tags: List[str] = []
    seen = set()
    for part in raw.split(","):
        tag = part.strip().lower()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag)
    return tags


def clean_section_text(text: str) -> str:
    text = text.replace("\u3000", " ")
    text = text.replace("\t", " ")
    text = text.replace("cite", " ")
    text = text.replace("（", "(").replace("）", ")")
    text = re.sub(r"[•]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def split_city_sections(text: str) -> Iterable[tuple[str, str]]:
    city_re = re.compile(r"(?im)^\s*[•\-\*\t ]*City\s*:\s*([^\n\r]+)")
    matches = list(city_re.finditer(text))
    for idx, match in enumerate(matches):
        city = normalize_city(match.group(1))
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        yield city, text[start:end]


def parse_type(raw: str) -> Optional[str]:
    lowered = raw.strip().lower()
    return TYPE_ALIASES.get(lowered, lowered) if lowered in TYPE_ALIASES or lowered in VALID_TYPES else None


def parse_city_items(city: str, section_text: str) -> List[ParsedItem]:
    cleaned = clean_section_text(section_text)
    excellence_re = re.compile(r"\|\s*excellence\s*:\s*([0-9]*\.?[0-9]+)", re.IGNORECASE)
    tags_re = re.compile(r"\|\s*tags\s*:\s*(.*?)\s*\|\s*excellence\s*:", re.IGNORECASE)
    type_re = re.compile(r"(?:\[\s*)?(food|culture|walk|ure|ture|k)\s*\]", re.IGNORECASE)
    id_re = re.compile(r"\bid\s*:\s*([a-zA-Z0-9._-]+)", re.IGNORECASE)
    source_re = re.compile(r"\bsource\s*:\s*([^\|\n\r]+)", re.IGNORECASE)
    desc_re = re.compile(r"\bdescription\s*:\s*([^\|\n\r]+)", re.IGNORECASE)

    items: List[ParsedItem] = []
    last_type: Optional[str] = None
    cursor = 0

    for ex_match in excellence_re.finditer(cleaned):
        chunk = cleaned[cursor:ex_match.end()]
        cursor = ex_match.end()

        tags_match = tags_re.search(chunk)
        if not tags_match:
            continue

        tags_raw = tags_match.group(1)
        prefix = chunk[: tags_match.start()]
        suffix = chunk[tags_match.end() :]

        type_matches = list(type_re.finditer(prefix))
        item_type: Optional[str] = None
        title = ""
        if type_matches:
            raw_type = type_matches[-1].group(1)
            item_type = parse_type(raw_type)
            type_end = type_matches[-1].end()
            title = prefix[type_end:]
        elif last_type and "]" in prefix:
            item_type = last_type
            title = prefix[prefix.rfind("]") + 1 :]

        if not item_type:
            continue

        item_type = item_type.lower()
        last_type = item_type
        if item_type not in VALID_TYPES:
            continue

        title = normalize_title(title)
        if not title:
            continue

        tags = normalize_tags(tags_raw)
        excellence = clamp(float(ex_match.group(1)), 0.0, 1.0)
        item_id = None
        id_match = id_re.search(chunk)
        if id_match:
            item_id = id_match.group(1).strip()

        source = "data.txt"
        source_match = source_re.search(chunk)
        if source_match:
            source = source_match.group(1).strip() or "data.txt"

        description = None
        desc_match = desc_re.search(suffix)
        if desc_match:
            description = desc_match.group(1).strip() or None

        items.append(
            ParsedItem(
                item_id=item_id,
                city=city,
                item_type=item_type,
                title=title,
                tags=tags,
                excellence=excellence,
                description=description,
                source=source,
            )
        )

    return items


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS reco_items (
            item_id TEXT PRIMARY KEY,
            city TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            excellence REAL NOT NULL,
            description TEXT,
            source TEXT DEFAULT 'data.txt',
            created_at TEXT,
            updated_at TEXT
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reco_city ON reco_items (city)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reco_city_type ON reco_items (city, type)")


def validate_items(items: List[ParsedItem]) -> None:
    city_counts: Dict[str, Counter] = defaultdict(Counter)
    for item in items:
        city_counts[item.city]["total"] += 1
        city_counts[item.city][item.item_type] += 1

    out_of_range_violations: List[str] = []
    target_mismatch_warnings: List[str] = []
    for city in sorted(city_counts):
        total = city_counts[city]["total"]
        food = city_counts[city]["food"]
        culture = city_counts[city]["culture"]
        walk = city_counts[city]["walk"]

        in_reasonable_range = (
            REASONABLE_RANGES["total"][0] <= total <= REASONABLE_RANGES["total"][1]
            and REASONABLE_RANGES["food"][0] <= food <= REASONABLE_RANGES["food"][1]
            and REASONABLE_RANGES["culture"][0] <= culture <= REASONABLE_RANGES["culture"][1]
            and REASONABLE_RANGES["walk"][0] <= walk <= REASONABLE_RANGES["walk"][1]
        )
        if not in_reasonable_range:
            out_of_range_violations.append(
                f"city={city} total={total} food={food} culture={culture} walk={walk}"
            )
        elif (
            total != TARGET_TOTAL_PER_CITY
            or food != TARGET_TYPE_COUNTS["food"]
            or culture != TARGET_TYPE_COUNTS["culture"]
            or walk != TARGET_TYPE_COUNTS["walk"]
        ):
            target_mismatch_warnings.append(
                f"city={city} total={total} food={food} culture={culture} walk={walk}"
            )

    deny_violations: List[str] = []
    for item in items:
        lowered = item.title.strip().lower()
        tokens = [t for t in re.split(r"\s+", lowered) if t]
        if item.item_type == "food" and len(tokens) == 1 and tokens[0] in GENERIC_FOOD_DENYLIST:
            deny_violations.append(
                f"city={item.city} item_id={item.item_id or '(generated)'} title={item.title}"
            )

    if out_of_range_violations:
        print("Validation failed: city count/type count outside reasonable range")
        print(
            "Reasonable ranges: "
            f"total={REASONABLE_RANGES['total']}, "
            f"food={REASONABLE_RANGES['food']}, "
            f"culture={REASONABLE_RANGES['culture']}, "
            f"walk={REASONABLE_RANGES['walk']}"
        )
        for row in out_of_range_violations:
            print(f"  - {row}")
        raise SystemExit(1)

    if target_mismatch_warnings:
        print("Validation warning: city counts differ from target 50/22/18/10 (continuing)")
        for row in target_mismatch_warnings:
            print(f"  - {row}")

    if deny_violations:
        print("Validation failed: generic food titles detected")
        for row in deny_violations:
            print(f"  - {row}")
        raise SystemExit(1)


def upsert_items(conn: sqlite3.Connection, items: List[ParsedItem]) -> None:
    now = utc_now_iso()
    by_city_type_index: Dict[tuple[str, str], int] = defaultdict(int)

    for item in items:
        if not item.item_id:
            by_city_type_index[(item.city, item.item_type)] += 1
            idx = by_city_type_index[(item.city, item.item_type)]
            item_id = f"{item.city}_{item.item_type}_{idx:03d}"
        else:
            item_id = item.item_id

        conn.execute(
            """
            INSERT INTO reco_items (
                item_id, city, type, title, tags_json, excellence,
                description, source, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(item_id) DO UPDATE SET
                city = excluded.city,
                type = excluded.type,
                title = excluded.title,
                tags_json = excluded.tags_json,
                excellence = excluded.excellence,
                description = excluded.description,
                source = excluded.source,
                updated_at = excluded.updated_at
            """,
            (
                item_id,
                item.city,
                item.item_type,
                item.title,
                json.dumps(item.tags, ensure_ascii=True),
                item.excellence,
                item.description,
                item.source or "data.txt",
                now,
                now,
            ),
        )


def read_all_items(input_path: Path) -> List[ParsedItem]:
    text = input_path.read_text(encoding="utf-8")
    parsed_items: List[ParsedItem] = []
    for city, section in split_city_sections(text):
        parsed_items.extend(parse_city_items(city, section))
    return parsed_items


def main() -> None:
    service_root = Path(__file__).resolve().parents[1]
    input_path = service_root / "data" / "data.txt"
    db_path = service_root / "data" / "reco.db"

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            ensure_schema(conn)
    finally:
        conn.close()

    items = read_all_items(input_path)
    validate_items(items)

    conn = sqlite3.connect(db_path)
    try:
        with conn:
            upsert_items(conn, items)
    finally:
        conn.close()

    city_count = len({item.city for item in items})
    print(f"Import complete: items={len(items)} cities={city_count} db={db_path}")


if __name__ == "__main__":
    main()
