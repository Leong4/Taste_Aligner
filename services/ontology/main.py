from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from .normalize_rules import normalize_tags

app = FastAPI()


class Payload(BaseModel):
    data: dict | None = None


@app.post("/normalize")
async def endpoint(payload: Payload):
    return normalize_tags(payload)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5003)
