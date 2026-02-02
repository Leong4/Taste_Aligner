"""
Ontology Service - Tag Normalization API

FastAPI service for normalizing tags using the production tag dictionary.
Provides semantic taxonomy mapping with multilingual support.
"""

from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from .normalize_rules import normalize_tags

app = FastAPI(title="Taste Aligner Ontology Service")


class Payload(BaseModel):
    data: dict | None = None


@app.post("/normalize")
async def normalize_endpoint(payload: Payload):
    """
    Normalize tags to canonical form.

    Accepts:
        - data.tags: string or list[str]

    Returns:
        - dummy: false (production mode)
        - raw: original tags
        - normalized: canonical tags
        - taxonomy: category/subcategory mapping
        - mapping_used: alias -> canonical mappings
    """
    return normalize_tags(payload)


@app.get("/health")
async def health_check():
    """Health check endpoint for service monitoring."""
    return {
        "ok": True,
        "service": "ontology"
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5003)
