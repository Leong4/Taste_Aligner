from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from .card_builder import compose_cards

app = FastAPI()


class Payload(BaseModel):
    city: str | None = None
    cz: list | None = None
    ez: list | None = None
    user_id: str | None = None
    data: dict | None = None


@app.post("/compose")
async def endpoint(payload: Payload):
    return compose_cards(payload)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5006)
