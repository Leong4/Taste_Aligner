from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from .vector_utils import generate_embedding

app = FastAPI()


class Payload(BaseModel):
    data: dict | None = None


@app.post("/generate")
async def endpoint(payload: Payload):
    return generate_embedding(payload)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5004)

