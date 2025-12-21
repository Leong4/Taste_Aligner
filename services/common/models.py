from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class MemoryRecord(BaseModel):
    memory_id: str
    title: str
    city: str
    sentiment: float
    tags: List[str] = []
    notes: Optional[str] = None


class JourneyCard(BaseModel):
    title: str
    itinerary: List[Dict[str, Any]]
    memory_anchors: List[Dict[str, Any]] = []
    generated_at: str


class ServiceResponse(BaseModel):
    dummy: bool = True
    data: Dict[str, Any] = {}

