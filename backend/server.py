from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime
from typing import Optional, Literal
import sqlite3
import subprocess
import json
import os
import re
import uuid
import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------

HOME = Path.home()
WORKSPACE = (HOME / ".openclaw" / "workspace").resolve()
BACKUPS_DIR = WORKSPACE / ".backups"
STATE_DIR = WORKSPACE / "state"
STATE_FILE = STATE_DIR / "skills-state.json"

BASE = Path(__file__).parent.parent
DB_PATH = BASE / "data" / "assistant.db"
DB_PATH.parent.mkdir(exist_ok=True)

OPENCLAW_BIN = "/opt/homebrew/bin/openclaw"

# Files the UI is allowed to read AND write via /config/file.
ALLOWED_CONFIG_PATHS = {
    "SOUL.md",
    "IDENTITY.md",
    "USER.md",
    "AGENTS.md",
    "JSP-CONTEXT.md",
    "MEMORY.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "agents/personal/SOUL.md",
    "agents/personal/AGENTS.md",
    "agents/marketing/SOUL.md",
    "agents/marketing/AGENTS.md",
}

BACKUPS_MAX = 10
SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9\-]{1,39}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
EXCLUDE_TREE_NAMES = {".git", "node_modules", ".DS_Store", ".backups"}

# Core skills registry — mirrors scaffolds on disk under
# ~/.openclaw/workspace/agents/{personal,marketing}/skills/.
CORE_SKILLS = [
    {"id": "daily-briefing",  "name": "Daily briefing",   "description": "Morning summary — calendar, inbox, overnight news.",            "group": "personal",  "status": "scaffold"},
    {"id": "calendar-check",  "name": "Calendar check",   "description": "Read-only calendar lookups with travel buffers.",               "group": "personal",  "status": "scaffold"},
    {"id": "email-triage",    "name": "Email triage",     "description": "Sorts and prioritises inbox — never sends a reply.",            "group": "personal",  "status": "scaffold"},
    {"id": "meeting-prep",    "name": "Meeting prep",     "description": "One-page brief before a meeting — attendees, context, agenda.", "group": "personal",  "status": "scaffold"},
    {"id": "note-capture",    "name": "Note capture",     "description": "Files a quick thought into memory.",                            "group": "personal",  "status": "scaffold"},
    {"id": "identify-man",    "name": "Identify the MAN", "description": "Finds the MAN at a company — shareholder priority order.",      "group": "marketing", "status": "scaffold"},
    {"id": "enrich-contact",  "name": "Enrich contact",   "description": "Gets email + mobile via Cognism → Lusha cascade.",              "group": "marketing", "status": "scaffold"},
    {"id": "pipeline-review", "name": "Pipeline review",  "description": "Current batch status — found, pending, spend vs cap.",          "group": "marketing", "status": "scaffold"},
    {"id": "lead-batch-run",  "name": "Lead batch run",   "description": "Processes a full batch end-to-end with budget guards.",         "group": "marketing", "status": "scaffold"},
    {"id": "campaign-draft",  "name": "Campaign draft",   "description": "Drafts outreach — marked awaiting approval, never sends.",      "group": "marketing", "status": "scaffold"},
]

# ---------------------------------------------------------------------------
# App bootstrap (keep existing DB and CORS config)
# ---------------------------------------------------------------------------

# DB bootstrap. The pre-Smart-Chat schema had a single `conversations` table
# that stored individual messages (columns: id, role, content, created_at).
# The new schema splits that into `conversations` (metadata) + `messages`.
# If the old table shape is still on disk, rename it before creating the new one.
_conn = sqlite3.connect(DB_PATH)
_conn.row_factory = sqlite3.Row
_cur = _conn.cursor()
_existing = _cur.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"
).fetchone()
if _existing:
    _cols = [r["name"] for r in _cur.execute("PRAGMA table_info(conversations)").fetchall()]
    if "uuid" not in _cols:
        _cur.execute("ALTER TABLE conversations RENAME TO conversations_legacy")
        _conn.commit()
_conn.executescript("""
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL,
  title TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model_used TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_mode_updated
  ON conversations(mode, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
""")
_conn.close()


def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # ON DELETE CASCADE requires FK enforcement per connection.
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

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

# ---------------------------------------------------------------------------
# Path safety helpers
# ---------------------------------------------------------------------------

def _resolve_under_workspace(rel_path: str) -> Path:
    """Resolve a workspace-relative path, refusing anything outside the workspace."""
    if not rel_path:
        raise HTTPException(status_code=400, detail="Path is required.")
    norm = rel_path.replace("\\", "/")
    if norm.startswith("/"):
        raise HTTPException(status_code=400, detail="Path must be workspace-relative, not absolute.")
    if ".." in Path(norm).parts:
        raise HTTPException(status_code=400, detail="Parent-directory references are not allowed.")
    full = (WORKSPACE / norm).resolve()
    try:
        full.relative_to(WORKSPACE)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escapes the workspace.")
    return full


def _require_allowed_config(rel_path: str) -> Path:
    """Same as _resolve_under_workspace but also requires the path is in the editable allowlist."""
    norm = rel_path.replace("\\", "/").lstrip("/")
    if norm not in ALLOWED_CONFIG_PATHS:
        raise HTTPException(status_code=403, detail=f"'{norm}' is not in the editable-files allowlist.")
    return _resolve_under_workspace(norm)


# ---------------------------------------------------------------------------
# Backup helpers
# ---------------------------------------------------------------------------

def _backup_token(rel_path: str) -> str:
    return rel_path.replace("/", "__")


def _list_backups(rel_path: str) -> list[dict]:
    if not BACKUPS_DIR.exists():
        return []
    token = _backup_token(rel_path)
    # Accept both legacy (seconds) and current (seconds + microseconds) formats.
    pattern = re.compile(rf"^{re.escape(token)}\.(\d{{8}}-\d{{6}})(?:-(\d{{6}}))?\.bak$")
    out = []
    for entry in sorted(BACKUPS_DIR.iterdir(), reverse=True):
        m = pattern.match(entry.name)
        if not m:
            continue
        ts = m.group(1)
        human = f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]} {ts[9:11]}:{ts[11:13]}:{ts[13:15]}"
        out.append({"file": entry.name, "timestamp": human, "rel_path": rel_path})
    return out


def _make_backup(rel_path: str, abs_path: Path) -> Optional[str]:
    """Back up current content before we overwrite it. Returns backup filename or None if the target doesn't exist yet."""
    if not abs_path.exists():
        return None
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    token = _backup_token(rel_path)
    # Seconds + microseconds so rapid saves don't collide in the same second.
    now = datetime.now()
    stamp = now.strftime("%Y%m%d-%H%M%S") + f"-{now.microsecond:06d}"
    backup_path = BACKUPS_DIR / f"{token}.{stamp}.bak"
    backup_path.write_bytes(abs_path.read_bytes())
    # Rotate — keep the most recent BACKUPS_MAX per path.
    existing = sorted(
        BACKUPS_DIR.glob(f"{token}.*.bak"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in existing[BACKUPS_MAX:]:
        try:
            old.unlink()
        except OSError:
            pass
    return backup_path.name


def _iso_mtime(p: Path) -> Optional[str]:
    if not p.exists():
        return None
    return datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Skills helpers
# ---------------------------------------------------------------------------

def _load_skill_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_skill_state(d: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(d, indent=2) + "\n", encoding="utf-8")


def _discover_skills() -> list[dict]:
    state = _load_skill_state()
    known_ids = {s["id"] for s in CORE_SKILLS}
    result = []
    for s in CORE_SKILLS:
        item = dict(s)
        item["on"] = bool(state.get(s["id"], {}).get("on", False))
        item["custom"] = False
        result.append(item)
    for group in ("personal", "marketing"):
        skills_dir = WORKSPACE / "agents" / group / "skills"
        if not skills_dir.exists():
            continue
        for entry in sorted(skills_dir.iterdir()):
            if not entry.is_dir() or entry.name in known_ids:
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.exists():
                continue
            name = entry.name.replace("-", " ").title()
            description = ""
            try:
                lines = skill_md.read_text(encoding="utf-8").splitlines()
                for line in lines:
                    if line.startswith("# "):
                        name = line[2:].strip()
                        break
                in_purpose = False
                for line in lines:
                    stripped = line.strip()
                    if stripped == "## Purpose":
                        in_purpose = True
                        continue
                    if in_purpose:
                        if stripped and not stripped.startswith("#"):
                            description = stripped
                            break
            except OSError:
                pass
            result.append({
                "id": entry.name,
                "name": name,
                "description": description,
                "group": group,
                "status": "scaffold",
                "on": bool(state.get(entry.name, {}).get("on", False)),
                "custom": True,
            })
    return result


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    mode: Optional[Literal["personal", "marketing"]] = None
    conversation_id: Optional[str] = None  # conversation uuid


class SavePayload(BaseModel):
    path: str
    content: str


class TitlePayload(BaseModel):
    title: str


class RestorePayload(BaseModel):
    path: str
    backup: str  # filename under .backups/


class CustomSkillPayload(BaseModel):
    name: str
    display_name: str
    description: str
    group: Literal["personal", "marketing"]
    purpose: str
    inputs: str
    outputs: str


# ---------------------------------------------------------------------------
# Brain routing (fast / deep)
# ---------------------------------------------------------------------------
#
# Philosophy (from the task spec): automatic routing, Jackson doesn't pick.
#   FAST = anthropic/claude-sonnet-4-6  (default OpenClaw model)
#   DEEP = anthropic/claude-opus-4-7
#   ROUTER = anthropic/claude-haiku-4-5-20251001  (tiny classifier)
#
# Two-layered router so the feature still works without an API key in env:
#   1. If ANTHROPIC_API_KEY is set in the backend environment, call Haiku
#      with a strict classifier prompt (hard 2-second timeout).
#   2. Otherwise, fall back to a deterministic keyword-plus-length heuristic.
# In both cases we default to FAST on any error — deep should be the exception.

ROUTER_PROMPT = (
    "You are a classifier. Read this user message and decide if it needs "
    "FAST or DEEP reasoning.\n\n"
    "DEEP is for: strategic decisions, multi-step analysis, weighing options, "
    "comparing complex alternatives, negotiations requiring judgment, "
    "'help me think through X', multi-part questions where each part "
    "requires reasoning.\n\n"
    "FAST is for: factual lookups, simple drafts, summaries, "
    "calendar/inbox/file queries, short replies, quick follow-ups, "
    "anything that doesn't require hard thinking.\n\n"
    "Respond with exactly one word: FAST or DEEP.\n\n"
    "User message: {message}\n"
    "Context mode: {mode}"
)

_DEEP_HINTS = (
    "help me think", "think through", "weigh", "trade-off", "trade off",
    "tradeoff", "pros and cons", "compare ", "strategy", "strategic",
    "analyse", "analyze", "should we ", "should i ", "why would",
    "negotiat", "decide between", "decide whether", "evaluate", "assessment",
    "prioriti", "long-term", "roadmap",
)


def _heuristic_brain(message: str) -> str:
    """Deterministic keyword + length classifier. Default FAST."""
    m = message.lower()
    if any(h in m for h in _DEEP_HINTS):
        return "deep"
    # Long, multi-clause questions with newlines are also DEEP candidates.
    if len(message) > 320 and ("?" in message or "\n" in message):
        return "deep"
    return "fast"


def _haiku_brain(api_key: str, message: str, mode: str) -> Optional[str]:
    """Call Haiku to classify. Returns 'fast'/'deep', or None on any failure."""
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 4,
        "messages": [{
            "role": "user",
            "content": ROUTER_PROMPT.format(message=message, mode=mode or "personal"),
        }],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None
    for block in data.get("content", []):
        if block.get("type") == "text":
            word = (block.get("text") or "").strip().upper()
            if "DEEP" in word:
                return "deep"
            if "FAST" in word:
                return "fast"
    return None


def route_to_brain(message: str, mode: str) -> str:
    """Returns 'fast' or 'deep'. Defaults to 'fast' on any failure."""
    api_key = (os.environ.get("ANTHROPIC_API_KEY") or "").strip()
    if api_key:
        decided = _haiku_brain(api_key, message, mode)
        if decided in ("fast", "deep"):
            return decided
    return _heuristic_brain(message)


# ---------------------------------------------------------------------------
# Health & chat
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "local": True, "workspace": str(WORKSPACE)}


def _invoke_openclaw(prefixed: str, brain: str, session_id: Optional[str]) -> subprocess.CompletedProcess:
    """Run the main OpenClaw agent. Threads session_id through so each Mission
    Control conversation maps to a dedicated OpenClaw session (fresh system
    prompt on first turn, continuity across later turns in the same chat).

    For the deep brain we pass --thinking high and set ANTHROPIC_MODEL in the
    subprocess env so the gateway picks Opus if it honours the override. If
    OpenClaw ignores both (model pinned in openclaw.json), the reply still
    goes through — it just uses the configured primary."""
    cmd = [OPENCLAW_BIN, "agent", "--agent", "main", "--message", prefixed]
    if session_id:
        cmd.extend(["--session-id", session_id])
    env = os.environ.copy()
    if brain == "deep":
        cmd.extend(["--thinking", "high"])
        env["ANTHROPIC_MODEL"] = "anthropic/claude-opus-4-7"
    return subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env)


@app.post("/chat")
def chat(req: ChatRequest):
    effective_mode = req.mode or "personal"
    message = req.message

    # Find or create the conversation row.
    conn = _db()
    cur = conn.cursor()
    if req.conversation_id:
        row = cur.execute(
            "SELECT id, mode FROM conversations WHERE uuid = ?",
            (req.conversation_id,),
        ).fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="Conversation not found.")
        conv_id = row["id"]
        conv_uuid = req.conversation_id
    else:
        conv_uuid = str(uuid.uuid4())
        title = (message.strip().splitlines()[0] if message.strip() else "Untitled")[:50] or "Untitled"
        cur.execute(
            "INSERT INTO conversations (uuid, mode, title) VALUES (?, ?, ?)",
            (conv_uuid, effective_mode, title),
        )
        conv_id = cur.lastrowid

    # Save user message before invoking OpenClaw so it's never lost on failure.
    cur.execute(
        "INSERT INTO messages (conversation_id, role, content, model_used) VALUES (?, ?, ?, NULL)",
        (conv_id, "user", message),
    )
    conn.commit()

    # Prefix for the main agent's routing.
    if effective_mode == "marketing":
        prefixed = "[marketing] " + message
    else:
        prefixed = "[personal] " + message

    brain = route_to_brain(message, effective_mode)
    model_used = "opus" if brain == "deep" else "sonnet"

    try:
        result = _invoke_openclaw(prefixed, brain, conv_uuid)
        if result.returncode != 0 and brain == "deep":
            # Deep failed — one retry on fast before giving up.
            brain = "fast"
            model_used = "sonnet"
            result = _invoke_openclaw(prefixed, brain, conv_uuid)
        if result.returncode != 0:
            conn.close()
            raise HTTPException(
                status_code=500,
                detail=f"OpenClaw error: {(result.stderr or 'unknown').strip()}",
            )
        reply = result.stdout.strip()

        cur.execute(
            "INSERT INTO messages (conversation_id, role, content, model_used) VALUES (?, ?, ?, ?)",
            (conv_id, "assistant", reply, model_used),
        )
        cur.execute(
            "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (conv_id,),
        )
        conn.commit()
        conn.close()

        return {
            "reply": reply,
            "mode": effective_mode,
            "conversation_id": conv_uuid,
            "model_used": model_used,
        }

    except subprocess.TimeoutExpired:
        conn.close()
        raise HTTPException(status_code=504, detail="OpenClaw timed out.")
    except HTTPException:
        raise
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=500, detail=f"Chat failed: {e}")


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

@app.get("/conversations")
def conversations_list(mode: Optional[Literal["personal", "marketing"]] = Query(None)):
    conn = _db()
    if mode:
        rows = conn.execute(
            """
            SELECT c.uuid, c.mode, c.title, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE c.mode = ?
            GROUP BY c.id
            ORDER BY c.updated_at DESC
            """,
            (mode,),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT c.uuid, c.mode, c.title, c.created_at, c.updated_at,
                   COUNT(m.id) AS message_count
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.updated_at DESC
            """,
        ).fetchall()
    conn.close()
    return {"conversations": [dict(r) for r in rows]}


@app.get("/conversations/{conv_uuid}")
def conversation_detail(conv_uuid: str):
    conn = _db()
    conv = conn.execute(
        "SELECT id, uuid, mode, title, created_at, updated_at FROM conversations WHERE uuid = ?",
        (conv_uuid,),
    ).fetchone()
    if not conv:
        conn.close()
        raise HTTPException(status_code=404, detail="Conversation not found.")
    msgs = conn.execute(
        """
        SELECT role, content, model_used, created_at
        FROM messages
        WHERE conversation_id = ?
        ORDER BY id ASC
        """,
        (conv["id"],),
    ).fetchall()
    conn.close()
    return {
        "uuid": conv["uuid"],
        "mode": conv["mode"],
        "title": conv["title"],
        "created_at": conv["created_at"],
        "updated_at": conv["updated_at"],
        "messages": [dict(m) for m in msgs],
    }


@app.delete("/conversations/{conv_uuid}")
def conversation_delete(conv_uuid: str):
    conn = _db()
    cur = conn.cursor()
    cur.execute("DELETE FROM conversations WHERE uuid = ?", (conv_uuid,))
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Conversation not found.")
    conn.commit()
    conn.close()
    return {"ok": True, "uuid": conv_uuid}


@app.patch("/conversations/{conv_uuid}")
def conversation_rename(conv_uuid: str, payload: TitlePayload):
    title = payload.title.strip()[:100]
    if not title:
        raise HTTPException(status_code=400, detail="Title is required.")
    conn = _db()
    cur = conn.cursor()
    cur.execute(
        "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE uuid = ?",
        (title, conv_uuid),
    )
    if cur.rowcount == 0:
        conn.close()
        raise HTTPException(status_code=404, detail="Conversation not found.")
    conn.commit()
    conn.close()
    return {"ok": True, "uuid": conv_uuid, "title": title}


# ---------------------------------------------------------------------------
# Config (editable workspace files)
# ---------------------------------------------------------------------------

@app.get("/config/files")
def config_files():
    items = []
    for rel in sorted(ALLOWED_CONFIG_PATHS):
        abs_p = WORKSPACE / rel
        items.append({
            "path": rel,
            "exists": abs_p.exists(),
            "mtime": _iso_mtime(abs_p),
            "size": abs_p.stat().st_size if abs_p.exists() else 0,
        })
    return {"files": items}


@app.get("/config/file")
def config_file_get(path: str = Query(...)):
    abs_p = _require_allowed_config(path)
    if not abs_p.exists():
        return {
            "path": path,
            "content": "",
            "exists": False,
            "mtime": None,
            "backups": _list_backups(path),
        }
    return {
        "path": path,
        "content": abs_p.read_text(encoding="utf-8"),
        "exists": True,
        "mtime": _iso_mtime(abs_p),
        "backups": _list_backups(path),
    }


@app.put("/config/file")
def config_file_put(payload: SavePayload):
    abs_p = _require_allowed_config(payload.path)
    backup_name = _make_backup(payload.path, abs_p)
    abs_p.parent.mkdir(parents=True, exist_ok=True)
    abs_p.write_text(payload.content, encoding="utf-8")
    return {
        "ok": True,
        "path": payload.path,
        "mtime": _iso_mtime(abs_p),
        "backup": backup_name,
        "backups": _list_backups(payload.path),
    }


@app.get("/config/backups")
def config_backups(path: str = Query(...)):
    _require_allowed_config(path)
    return {"path": path, "backups": _list_backups(path)}


@app.post("/config/restore")
def config_restore(payload: RestorePayload):
    abs_p = _require_allowed_config(payload.path)
    token = _backup_token(payload.path)
    # Only accept backups that belong to this path AND match the timestamped shape.
    if not re.match(rf"^{re.escape(token)}\.\d{{8}}-\d{{6}}(?:-\d{{6}})?\.bak$", payload.backup):
        raise HTTPException(status_code=400, detail="Backup filename does not belong to this path.")
    backup_file = BACKUPS_DIR / payload.backup
    # Harden: make sure the backup file itself is in the backups dir.
    try:
        backup_file.resolve().relative_to(BACKUPS_DIR.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid backup path.")
    if not backup_file.is_file():
        raise HTTPException(status_code=404, detail="Backup not found.")
    # Snapshot current content before restoring so the user can redo.
    _make_backup(payload.path, abs_p)
    abs_p.write_bytes(backup_file.read_bytes())
    return {
        "ok": True,
        "path": payload.path,
        "restored_from": payload.backup,
        "mtime": _iso_mtime(abs_p),
        "backups": _list_backups(payload.path),
    }


# ---------------------------------------------------------------------------
# Skills
# ---------------------------------------------------------------------------

@app.get("/skills")
def skills_list():
    return {"skills": _discover_skills()}


@app.get("/skills/{skill_id}")
def skills_get(skill_id: str):
    skill = next((s for s in _discover_skills() if s["id"] == skill_id), None)
    if not skill:
        raise HTTPException(status_code=404, detail="Skill not found.")
    skill_md = WORKSPACE / "agents" / skill["group"] / "skills" / skill_id / "SKILL.md"
    content = skill_md.read_text(encoding="utf-8") if skill_md.exists() else ""
    return {
        "skill": skill,
        "content": content,
        "path": f"agents/{skill['group']}/skills/{skill_id}/SKILL.md",
        "mtime": _iso_mtime(skill_md),
    }


@app.put("/skills/{skill_id}/toggle")
def skills_toggle(skill_id: str):
    target = next((s for s in _discover_skills() if s["id"] == skill_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Skill not found.")
    state = _load_skill_state()
    current = bool(state.get(skill_id, {}).get("on", False))
    state[skill_id] = {"on": not current, "group": target["group"]}
    _save_skill_state(state)
    return {"skill_id": skill_id, "on": not current}


@app.post("/skills/custom")
def skills_custom(payload: CustomSkillPayload):
    if not SKILL_NAME_RE.match(payload.name):
        raise HTTPException(
            status_code=400,
            detail="Name must start with a lowercase letter and contain only lowercase letters, digits, or hyphens (2–40 chars).",
        )
    if payload.name in {s["id"] for s in CORE_SKILLS}:
        raise HTTPException(status_code=409, detail="That name clashes with a built-in skill.")
    skill_dir = WORKSPACE / "agents" / payload.group / "skills" / payload.name
    if skill_dir.exists():
        raise HTTPException(status_code=409, detail="A skill with that name already exists.")
    skill_dir.mkdir(parents=True)
    md = (
        f"# {payload.display_name.strip() or payload.name}\n\n"
        f"## Purpose\n\n"
        f"{payload.purpose.strip() or payload.description.strip()}\n\n"
        f"## Inputs\n\n"
        f"{payload.inputs.strip()}\n\n"
        f"## Outputs\n\n"
        f"{payload.outputs.strip()}\n\n"
        f"## Status\n\n"
        f"Scaffold only — created via the UI on {datetime.now().strftime('%Y-%m-%d')}. "
        f"Implementation pending.\n"
    )
    (skill_dir / "SKILL.md").write_text(md, encoding="utf-8")
    state = _load_skill_state()
    state[payload.name] = {"on": False, "group": payload.group}
    _save_skill_state(state)
    return {
        "ok": True,
        "id": payload.name,
        "path": f"agents/{payload.group}/skills/{payload.name}/SKILL.md",
    }


# ---------------------------------------------------------------------------
# Memory
# ---------------------------------------------------------------------------

@app.get("/memory/curated")
def memory_curated():
    p = WORKSPACE / "MEMORY.md"
    return {
        "content": p.read_text(encoding="utf-8") if p.exists() else "",
        "mtime": _iso_mtime(p),
        "exists": p.exists(),
    }


@app.get("/memory/daily")
def memory_daily(date: str = Query(...)):
    if not DATE_RE.match(date):
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD.")
    p = WORKSPACE / "memory" / f"{date}.md"
    return {
        "date": date,
        "content": p.read_text(encoding="utf-8") if p.exists() else "",
        "exists": p.exists(),
        "mtime": _iso_mtime(p),
    }


@app.get("/memory/daily/list")
def memory_daily_list():
    d = WORKSPACE / "memory"
    if not d.exists():
        return {"dates": []}
    dates = []
    for entry in sorted(d.iterdir()):
        if entry.is_file() and entry.suffix == ".md" and DATE_RE.match(entry.stem):
            dates.append(entry.stem)
    return {"dates": dates}


# ---------------------------------------------------------------------------
# Workspace (read-only tree + preview)
# ---------------------------------------------------------------------------

def _walk_tree(path: Path, depth: int, max_depth: int) -> list:
    if depth > max_depth:
        return []
    entries = []
    try:
        children = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
    except PermissionError:
        return []
    for entry in children:
        if entry.name in EXCLUDE_TREE_NAMES or entry.name.startswith("."):
            continue
        rel = entry.relative_to(WORKSPACE).as_posix()
        if entry.is_dir():
            entries.append({
                "name": entry.name,
                "path": rel,
                "type": "dir",
                "children": _walk_tree(entry, depth + 1, max_depth),
            })
        elif entry.is_file():
            entries.append({
                "name": entry.name,
                "path": rel,
                "type": "file",
                "size": entry.stat().st_size,
            })
    return entries


@app.get("/workspace/tree")
def workspace_tree(max_depth: int = Query(4, ge=1, le=6)):
    if not WORKSPACE.exists():
        raise HTTPException(status_code=500, detail="Workspace directory is missing on disk.")
    return {
        "root": str(WORKSPACE),
        "tree": _walk_tree(WORKSPACE, 1, max_depth),
    }


@app.get("/workspace/file")
def workspace_file(path: str = Query(...)):
    abs_p = _resolve_under_workspace(path)
    if not abs_p.exists():
        raise HTTPException(status_code=404, detail="File not found.")
    if abs_p.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory, not a file.")
    size = abs_p.stat().st_size
    if size > 500_000:
        raise HTTPException(status_code=413, detail="File is too large for preview (>500 KB).")
    try:
        content = abs_p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="Binary file — preview not supported.")
    return {
        "path": path,
        "content": content,
        "mtime": _iso_mtime(abs_p),
        "size": size,
    }
