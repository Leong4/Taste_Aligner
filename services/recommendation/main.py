from fastapi import FastAPI
from pydantic import BaseModel
import uvicorn
from .scorer import score_recommendations

app = FastAPI()


class Payload(BaseModel):
    data: dict | None = None


@app.post("/score")
async def endpoint(payload: Payload):
    return score_recommendations(payload)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5005)

