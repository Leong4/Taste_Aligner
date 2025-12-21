from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from .vision_core import describe_image

app = FastAPI()


class Payload(BaseModel):
    data: dict | None = None


@app.post("/describe")
async def endpoint(payload: Payload):
    return describe_image(payload)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5002)

