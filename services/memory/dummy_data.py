from typing import List, Dict, Any

_P5_RECORDS: List[Dict[str, Any]] = [
    {
        "memory_id": "p5_tokyo_ramen",
        "user_id": "user_123",
        "type": "food",
        "city": "Tokyo",
        "timestamp": "2024-01-05T20:15:00Z",
        "title": "Late-night ramen in Shinjuku",
        "notes": "Creamy tonkotsu broth with extra chashu; walked from hotel.",
        "tags": ["ramen", "japan", "comfort"],
        "sentiment": 0.87,
    },
    {
        "memory_id": "p5_kyoto_temple",
        "user_id": "user_123",
        "type": "culture",
        "city": "Kyoto",
        "timestamp": "2023-11-12T09:30:00Z",
        "title": "Morning visit to Fushimi Inari",
        "notes": "Hiked through torii gates, quiet and cool.",
        "tags": ["culture", "walking", "japan"],
        "sentiment": 0.91,
    },
]


def get_dummy_p5_records() -> List[Dict[str, Any]]:
    return [record.copy() for record in _P5_RECORDS]

