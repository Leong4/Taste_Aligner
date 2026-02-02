#!/usr/bin/env python3
"""
Recommendation Database Seeding Script

Creates and seeds the recommendation SQLite database with MVP dataset.
Safe to rerun (idempotent upsert).

Usage:
    python3 scripts/seed_reco_db.py
"""

import sqlite3
import json
import math
import os
from pathlib import Path


# Database path
REPO_ROOT = Path(__file__).parent.parent
DB_PATH = REPO_ROOT / "services/recommendation/data/reco.db"


def normalize_vector(vec):
    """L2 normalize a vector."""
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        return vec
    return [x / norm for x in vec]


def create_synthetic_embedding(seed_str: str, dim: int = 512) -> list:
    """
    Create deterministic synthetic embedding from seed string.

    This creates a pseudo-random but deterministic vector based on the seed,
    which is sufficient for v1.1 demonstration purposes.
    """
    # Use hash of seed to generate reproducible values
    hash_val = hash(seed_str)

    # Generate vector with some structure
    vec = []
    for i in range(dim):
        # Mix seed hash with position to create variety
        val = math.sin(hash_val * (i + 1) / 100.0)
        vec.append(val)

    return normalize_vector(vec)


# MVP Dataset: 33 items across 3 cities
MVP_DATASET = [
    # ============================================================
    # TOKYO (11 items)
    # ============================================================
    {
        "id": "tokyo_ramen_001",
        "city": "tokyo",
        "title": "Ichiran Ramen Shibuya",
        "tags": ["ramen", "japanese", "noodles", "comfort", "casual"],
        "excellence": 0.85,
        "description": "Famous tonkotsu ramen chain with customizable broth"
    },
    {
        "id": "tokyo_sushi_001",
        "city": "tokyo",
        "title": "Sukiyabashi Jiro",
        "tags": ["sushi", "japanese", "fine_dining", "seafood"],
        "excellence": 0.98,
        "description": "Three-Michelin-star sushi restaurant"
    },
    {
        "id": "tokyo_izakaya_001",
        "city": "tokyo",
        "title": "Omoide Yokocho",
        "tags": ["izakaya", "nightlife", "drinks", "japanese", "casual"],
        "excellence": 0.78,
        "description": "Narrow alley with traditional yakitori stalls"
    },
    {
        "id": "tokyo_temple_001",
        "city": "tokyo",
        "title": "Senso-ji Temple",
        "tags": ["temple", "culture", "walk", "sightseeing", "traditional"],
        "excellence": 0.92,
        "description": "Ancient Buddhist temple in Asakusa"
    },
    {
        "id": "tokyo_market_001",
        "city": "tokyo",
        "title": "Tsukiji Outer Market",
        "tags": ["market", "seafood", "japanese", "walk", "food"],
        "excellence": 0.88,
        "description": "Bustling market with fresh seafood and street food"
    },
    {
        "id": "tokyo_nightlife_001",
        "city": "tokyo",
        "title": "Golden Gai",
        "tags": ["nightlife", "drinks", "bars", "walk", "unique"],
        "excellence": 0.82,
        "description": "Tiny bars in Shinjuku's historic drinking quarter"
    },
    {
        "id": "tokyo_ramen_002",
        "city": "tokyo",
        "title": "Afuri Ramen",
        "tags": ["ramen", "japanese", "noodles", "yuzu", "modern"],
        "excellence": 0.80,
        "description": "Modern ramen with light yuzu-infused broth"
    },
    {
        "id": "tokyo_art_001",
        "city": "tokyo",
        "title": "TeamLab Borderless",
        "tags": ["art", "digital", "experience", "sightseeing", "modern"],
        "excellence": 0.91,
        "description": "Immersive digital art museum"
    },
    {
        "id": "tokyo_temple_002",
        "city": "tokyo",
        "title": "Meiji Shrine",
        "tags": ["temple", "culture", "walk", "nature", "peaceful"],
        "excellence": 0.89,
        "description": "Shinto shrine surrounded by forest"
    },
    {
        "id": "tokyo_ramen_003",
        "city": "tokyo",
        "title": "Nakiryu Ramen",
        "tags": ["ramen", "japanese", "noodles", "spicy", "michelin"],
        "excellence": 0.86,
        "description": "Michelin-starred tantanmen ramen"
    },
    {
        "id": "tokyo_view_001",
        "city": "tokyo",
        "title": "Shibuya Sky",
        "tags": ["view", "sightseeing", "walk", "modern", "photo"],
        "excellence": 0.84,
        "description": "Rooftop observation deck with city views"
    },
    {
        "id": "tokyo_chinese_001",
        "city": "tokyo",
        "title": "Sichuan Kitchen Tokyo",
        "tags": ["chinese", "noodles", "spicy", "sichuan", "casual"],
        "excellence": 0.82,
        "description": "Authentic Sichuan cuisine in Shinjuku"
    },
    {
        "id": "tokyo_chinese_002",
        "city": "tokyo",
        "title": "Beijing Dumpling House Akihabara",
        "tags": ["chinese", "dumplings", "northern", "casual", "traditional"],
        "excellence": 0.79,
        "description": "Hand-made northern Chinese dumplings"
    },
    {
        "id": "tokyo_chinese_003",
        "city": "tokyo",
        "title": "Shanghai Noodle Bar Roppongi",
        "tags": ["chinese", "noodles", "shanghai", "soup", "comfort"],
        "excellence": 0.81,
        "description": "Shanghai-style noodles and xiaolongbao"
    },
    {
        "id": "tokyo_chinese_004",
        "city": "tokyo",
        "title": "Chongqing Hotpot Shibuya",
        "tags": ["chinese", "hotpot", "spicy", "sichuan", "group"],
        "excellence": 0.83,
        "description": "Authentic Chongqing-style spicy hotpot"
    },

    # ============================================================
    # PARIS (11 items)
    # ============================================================
    {
        "id": "paris_bakery_001",
        "city": "paris",
        "title": "Du Pain et des Idées",
        "tags": ["bakery", "pastry", "french", "breakfast", "traditional"],
        "excellence": 0.90,
        "description": "Historic bakery with legendary pain des amis"
    },
    {
        "id": "paris_bistro_001",
        "city": "paris",
        "title": "Le Comptoir du Relais",
        "tags": ["bistro", "french", "wine", "fine_dining", "traditional"],
        "excellence": 0.87,
        "description": "Classic bistro with seasonal French cuisine"
    },
    {
        "id": "paris_cafe_001",
        "city": "paris",
        "title": "Café de Flore",
        "tags": ["cafe", "coffee", "french", "culture", "traditional"],
        "excellence": 0.83,
        "description": "Iconic Left Bank café frequented by philosophers"
    },
    {
        "id": "paris_museum_001",
        "city": "paris",
        "title": "Musée d'Orsay",
        "tags": ["museum", "art", "culture", "sightseeing", "impressionism"],
        "excellence": 0.95,
        "description": "Impressionist art museum in former train station"
    },
    {
        "id": "paris_dining_001",
        "city": "paris",
        "title": "Septime",
        "tags": ["fine_dining", "french", "wine", "modern", "michelin"],
        "excellence": 0.93,
        "description": "Michelin-starred modern French cuisine"
    },
    {
        "id": "paris_walk_001",
        "city": "paris",
        "title": "Le Marais Walk",
        "tags": ["walk", "culture", "sightseeing", "architecture", "historic"],
        "excellence": 0.86,
        "description": "Historic district with medieval streets"
    },
    {
        "id": "paris_street_food_001",
        "city": "paris",
        "title": "L'As du Fallafel",
        "tags": ["falafel", "middle_eastern", "street_food", "casual", "popular"],
        "excellence": 0.81,
        "description": "Famous falafel in the Marais"
    },
    {
        "id": "paris_museum_002",
        "city": "paris",
        "title": "Fondation Louis Vuitton",
        "tags": ["museum", "art", "modern", "architecture", "contemporary"],
        "excellence": 0.91,
        "description": "Contemporary art museum by Frank Gehry"
    },
    {
        "id": "paris_nightlife_001",
        "city": "paris",
        "title": "Le Mary Celeste",
        "tags": ["cocktails", "nightlife", "drinks", "modern", "trendy"],
        "excellence": 0.80,
        "description": "Trendy cocktail bar with small plates"
    },
    {
        "id": "paris_crepes_001",
        "city": "paris",
        "title": "Breizh Café",
        "tags": ["crepes", "french", "casual", "brunch", "traditional"],
        "excellence": 0.82,
        "description": "Authentic Breton crêpes and cider"
    },
    {
        "id": "paris_bookstore_001",
        "city": "paris",
        "title": "Shakespeare and Company",
        "tags": ["bookstore", "culture", "walk", "coffee", "historic"],
        "excellence": 0.85,
        "description": "Legendary English bookstore by the Seine"
    },

    # ============================================================
    # MILAN (11 items)
    # ============================================================
    {
        "id": "milan_trattoria_001",
        "city": "milan",
        "title": "Antica Trattoria della Pesa",
        "tags": ["italian", "pasta", "traditional", "fine_dining", "milanese"],
        "excellence": 0.88,
        "description": "Historic trattoria with classic Milanese cuisine"
    },
    {
        "id": "milan_gelato_001",
        "city": "milan",
        "title": "Gelateria della Musica",
        "tags": ["gelato", "italian", "dessert", "casual", "artisanal"],
        "excellence": 0.84,
        "description": "Artisanal gelato with creative flavors"
    },
    {
        "id": "milan_nightlife_001",
        "city": "milan",
        "title": "Navigli District",
        "tags": ["nightlife", "drinks", "walk", "culture", "canals"],
        "excellence": 0.81,
        "description": "Canal district with bars and restaurants"
    },
    {
        "id": "milan_art_001",
        "city": "milan",
        "title": "Fondazione Prada",
        "tags": ["art", "modern", "museum", "design", "contemporary"],
        "excellence": 0.92,
        "description": "Contemporary art complex by Rem Koolhaas"
    },
    {
        "id": "milan_fashion_001",
        "city": "milan",
        "title": "10 Corso Como",
        "tags": ["fashion", "design", "shopping", "cafe", "luxury"],
        "excellence": 0.87,
        "description": "Concept store with fashion, art, and café"
    },
    {
        "id": "milan_design_001",
        "city": "milan",
        "title": "Triennale Design Museum",
        "tags": ["design", "museum", "architecture", "modern", "culture"],
        "excellence": 0.89,
        "description": "Design and architecture museum in Parco Sempione"
    },
    {
        "id": "milan_street_food_001",
        "city": "milan",
        "title": "Luini Panzerotti",
        "tags": ["italian", "street_food", "casual", "traditional", "popular"],
        "excellence": 0.79,
        "description": "Iconic panzerotti since 1949"
    },
    {
        "id": "milan_cathedral_001",
        "city": "milan",
        "title": "Duomo di Milano",
        "tags": ["architecture", "culture", "sightseeing", "walk", "historic"],
        "excellence": 0.96,
        "description": "Gothic cathedral with rooftop views"
    },
    {
        "id": "milan_fine_dining_001",
        "city": "milan",
        "title": "Osteria Francescana (Modena trip)",
        "tags": ["italian", "fine_dining", "pasta", "wine", "michelin"],
        "excellence": 0.99,
        "description": "World's best restaurant - requires day trip"
    },
    {
        "id": "milan_walk_001",
        "city": "milan",
        "title": "Brera District Walk",
        "tags": ["walk", "art", "culture", "sightseeing", "bohemian"],
        "excellence": 0.83,
        "description": "Artistic neighborhood with galleries and cafés"
    },
    {
        "id": "milan_pastry_001",
        "city": "milan",
        "title": "Pasticceria Marchesi",
        "tags": ["pastry", "italian", "coffee", "traditional", "luxury"],
        "excellence": 0.86,
        "description": "Historic pastry shop since 1824"
    },
]


def init_database():
    """Initialize the recommendation database with schema."""
    print(f"Initializing database at: {DB_PATH}")

    # Ensure directory exists
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Create items table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            city TEXT NOT NULL,
            title TEXT NOT NULL,
            tags_json TEXT NOT NULL,
            excellence REAL NOT NULL,
            embedding_json TEXT NOT NULL,
            description TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Create indexes
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_city ON items(city)")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_excellence ON items(excellence)")

    conn.commit()
    conn.close()

    print("✓ Database schema created")


def seed_dataset():
    """Seed the database with MVP dataset (idempotent upsert)."""
    print(f"\nSeeding {len(MVP_DATASET)} items...")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    seeded_count = 0
    updated_count = 0

    for item in MVP_DATASET:
        # Generate deterministic embedding
        seed = f"{item['id']}_{item['city']}_{item['title']}"
        embedding = create_synthetic_embedding(seed, dim=512)

        # Check if exists
        cursor.execute("SELECT id FROM items WHERE id = ?", (item["id"],))
        exists = cursor.fetchone() is not None

        # Upsert
        cursor.execute("""
            INSERT OR REPLACE INTO items (
                id, city, title, tags_json, excellence,
                embedding_json, description, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            item["id"],
            item["city"],
            item["title"],
            json.dumps(item["tags"]),
            item["excellence"],
            json.dumps(embedding),
            item.get("description", "")
        ))

        if exists:
            updated_count += 1
        else:
            seeded_count += 1

    conn.commit()
    conn.close()

    print(f"✓ Seeded {seeded_count} new items")
    print(f"✓ Updated {updated_count} existing items")


def verify_dataset():
    """Verify the seeded dataset."""
    print("\nVerifying dataset...")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Count by city
    cursor.execute("SELECT city, COUNT(*) FROM items GROUP BY city ORDER BY city")
    city_counts = cursor.fetchall()

    print("\nCity distribution:")
    for city, count in city_counts:
        print(f"  {city}: {count} items")

    # Excellence distribution
    cursor.execute("SELECT MIN(excellence), AVG(excellence), MAX(excellence) FROM items")
    min_exc, avg_exc, max_exc = cursor.fetchone()
    print(f"\nExcellence range: {min_exc:.2f} - {max_exc:.2f} (avg: {avg_exc:.2f})")

    # Sample item
    cursor.execute("SELECT id, city, title, excellence FROM items LIMIT 1")
    sample = cursor.fetchone()
    if sample:
        print(f"\nSample item: {sample[0]} | {sample[1]} | {sample[2]} | {sample[3]:.2f}")

    conn.close()

    print("\n✓ Verification complete")


def main():
    print("=" * 60)
    print("Recommendation Database Seeding")
    print("=" * 60)

    init_database()
    seed_dataset()
    verify_dataset()

    print("\n" + "=" * 60)
    print("✓ Database ready at:")
    print(f"  {DB_PATH}")
    print("=" * 60)


if __name__ == "__main__":
    main()
