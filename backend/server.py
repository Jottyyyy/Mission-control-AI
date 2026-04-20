from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import sqlite3
import subprocess

BASE = Path(__file__).parent.parent
DB_PATH = BASE / "data" / "assistant.db"
DB_PATH.parent.mkdir(exist_ok=True)

# Initialize local DB for conversation history
conn = sqlite3.connect(DB_PATH)
conn.executescript("""
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  role TEXT,
  content TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
""")
conn.close()

app = FastAPI(title="Sir Adam's Assistant Adapter")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str

@app.get("/health")
def health():
    return {"status": "ok", "local": True}

@app.post("/chat")
def chat(req: ChatRequest):
    try:
        result = subprocess.run(
            ["/opt/homebrew/bin/openclaw", "agent", "--agent", "main", "--message", req.message],
            capture_output=True,
            text=True,
            timeout=300
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"OpenClaw error: {result.stderr}"
            )
        reply = result.stdout.strip()

        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO conversations (role, content) VALUES (?, ?)",
            ("user", req.message)
        )
        conn.execute(
            "INSERT INTO conversations (role, content) VALUES (?, ?)",
            ("assistant", reply)
        )
        conn.commit()
        conn.close()

        return {"reply": reply}

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="OpenClaw timed out")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
