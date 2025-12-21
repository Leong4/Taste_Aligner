from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn

from .dummy_data import get_dummy_p5_records
from .utils import validate_payload

app = FastAPI()


class Payload(BaseModel):
    data: dict | None = None


@app.post("/write")
async def write(payload: Payload):
    validated = validate_payload(payload.data)
    return {
        "status": "ok",
        "message": "dummy write success",
        "written": validated
    }


@app.post("/read")
async def search(payload: Payload):
    return {
        "results": get_dummy_p5_records()
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5001)