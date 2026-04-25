from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Literal
import sqlite3
import subprocess
import json
import os
import re
import uuid
import base64
import csv
import io
import urllib.request
import urllib.parse
import urllib.error
from email.mime.text import MIMEText

# Keychain. Hard-fail import — the task requires Keychain-only storage.
import keyring  # noqa: E402
import keyring.errors  # noqa: E402

# MAN workflow clients (read Keychain via the same service/username convention).
from integrations import pomanda, cognism, lusha, ghl  # noqa: E402
from integrations import (  # noqa: E402
    google_oauth,
    google_calendar,
    google_gmail,
    google_drive,
    google_sheets,
    google_docs,
)
from workflows import man_workflow  # noqa: E402

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------

HOME = Path.home()
WORKSPACE = (HOME / ".openclaw" / "workspace").resolve()
BACKUPS_DIR = WORKSPACE / ".backups"
STATE_DIR = WORKSPACE / "state"
STATE_FILE = STATE_DIR / "skills-state.json"


def _resolve_data_dir() -> Path:
    """Writable data dir. Packaged: ~/Library/Application Support/Mission Control/data.
    Dev: <repo>/data. Override via MC_DATA_DIR env var.

    Without this, Path(__file__).parent.parent inside a .app bundle points at
    Resources/app/ which is read-only under macOS Gatekeeper — SQLite writes
    are silently rejected. See the handoff notes for the bug we're fixing."""
    override = os.environ.get("MC_DATA_DIR")
    if override:
        d = Path(override).expanduser()
    else:
        server_dir = Path(__file__).resolve().parent
        is_packaged = (
            "Resources/app/backend" in str(server_dir)
            or os.environ.get("MC_PACKAGED") == "1"
        )
        if is_packaged:
            d = Path.home() / "Library" / "Application Support" / "Mission Control" / "data"
        else:
            d = server_dir.parent / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


DATA_DIR = _resolve_data_dir()
DB_PATH = DATA_DIR / "assistant.db"

OPENCLAW_BIN = "/opt/homebrew/bin/openclaw"
OPENCLAW_CONFIG_PATH = HOME / ".openclaw" / "openclaw.json"
GATEWAY_PORT = 18789

# Hydrate ANTHROPIC_API_KEY from the Keychain early so the router (Haiku) and
# every openclaw subprocess inherits it. The onboarding flow writes the key
# under service="mission-control-ai", account="anthropic:api_key" (the same
# {tool_id}:{field} convention the rest of the integrations use). Setting
# os.environ at import time means the live backend picks up an existing key
# on every restart.
try:
    _kc_anthropic = keyring.get_password("mission-control-ai", "anthropic:api_key")
    if _kc_anthropic and not os.environ.get("ANTHROPIC_API_KEY"):
        os.environ["ANTHROPIC_API_KEY"] = _kc_anthropic
except keyring.errors.KeyringError:
    pass

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

-- Tool-calling infrastructure (Phase 1).
-- pending_actions holds draft actions the agent has proposed. Rows are created
-- when /chat detects an ```action:<type>``` marker; they transition to
-- 'executed' | 'cancelled' | 'expired'. The `id` IS the confirmation token —
-- the UI passes it back to POST /tools/execute.
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  action_type TEXT NOT NULL,
  action_data_json TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  executed_at TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- audit_log is immutable history of every action that actually fired (or
-- failed to fire after confirmation). Single-user deploy, so `user` defaults
-- to 'adam'.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  action_type TEXT NOT NULL,
  action_data_json TEXT NOT NULL,
  result_json TEXT,
  success INTEGER NOT NULL,
  user TEXT NOT NULL DEFAULT 'adam'
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_status
  ON pending_actions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
  ON audit_log(timestamp DESC);
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
    mode: Optional[Literal["personal", "marketing", "setup"]] = None
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


class ManLeadPayload(BaseModel):
    # Core identifier (required).
    name: str
    # Companies House number (preferred for Pomanda lookup).
    number: Optional[str] = None
    # Web / identifier fields (Zint provides domain, older callers used "website").
    website: Optional[str] = None
    domain: Optional[str] = None
    # Zint-provided candidate MAN + contact. When present we verify rather than
    # identify from scratch.
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    job_title: Optional[str] = None
    linkedin: Optional[str] = None
    email: Optional[str] = None
    mobile: Optional[str] = None
    # Contextual fields preserved for output, not used in enrichment logic.
    revenue: Optional[str] = None
    industry: Optional[str] = None
    hubspot_crm: Optional[str] = None
    pipeline_priority: Optional[str] = None
    headcount: Optional[str] = None
    ubo: Optional[str] = None
    # Full original row so the frontend can round-trip every Zint column on export.
    original_row: Optional[dict] = None

    class Config:
        extra = "allow"


class ManBatchPayload(BaseModel):
    leads: list[ManLeadPayload]
    max: Optional[int] = None


class ManSpreadsheetPayload(BaseModel):
    # JSON upload (not multipart) to avoid the python-multipart dep.
    # Frontend reads the file client-side with FileReader.readAsText()
    # and posts the resulting string here.
    filename: Optional[str] = None
    csv_content: str


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
# Credential scrubber (applied to every inbound chat message).
# ---------------------------------------------------------------------------
#
# If Tom pastes a token into chat by mistake (we tell him not to, but pasting
# happens) we MUST redact before: (a) logging the subprocess call, (b) saving
# to SQLite, (c) sending to the OpenClaw gateway / Anthropic.
#
# Patterns are intentionally broad. False-positive redactions are fine; the
# agent will just see "[redacted]" and ask Tom to use the form instead.

_CRED_PATTERNS = [
    # Google OAuth client secrets.
    re.compile(r"GOCSPX-[A-Za-z0-9_\-]{16,}"),
    # Google OAuth client IDs — 12-digit prefix + `-` + long hex + `.apps.gusercontent.com` suffix.
    re.compile(r"\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com"),
    # HubSpot Private App tokens (pat-) and legacy hapikey UUIDs.
    re.compile(r"pat-[a-z0-9-]{20,}", re.IGNORECASE),
    # Common API-key shapes seen from Anthropic/OpenAI/GHL/etc.
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
    # Bearer JWTs (ya29. access tokens, generic eyJ...). Capture conservatively.
    re.compile(r"ya29\.[A-Za-z0-9_\-]{20,}"),
    re.compile(r"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
    # Generic bearer / API-key lines where the user literally typed the prefix.
    re.compile(r"(?im)^\s*(?:bearer|authorization|api[_-]?key|token|secret)\s*[:=]\s*\S{12,}\s*$"),
    # Fallback: very long opaque strings that look like secrets (40+ chars, no spaces).
    re.compile(r"\b[A-Za-z0-9_\-]{40,}\b"),
]


def _scrub_credentials(text: str) -> str:
    """Replace anything that looks like an API key / token with [redacted].

    Applied to every inbound chat message before persistence or subprocess."""
    out = text
    for pat in _CRED_PATTERNS:
        out = pat.sub("[redacted]", out)
    return out


# ---------------------------------------------------------------------------
# Health & chat
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "local": True, "workspace": str(WORKSPACE)}


def _invoke_openclaw(
    prefixed: str,
    brain: str,
    session_id: Optional[str],
    model_override: Optional[str] = None,
) -> subprocess.CompletedProcess:
    """Run the main OpenClaw agent. Threads session_id through so each Mission
    Control conversation maps to a dedicated OpenClaw session (fresh system
    prompt on first turn, continuity across later turns in the same chat).

    For the deep brain we pass --thinking high and set ANTHROPIC_MODEL in the
    subprocess env so the gateway picks Opus if it honours the override. If
    OpenClaw ignores both (model pinned in openclaw.json), the reply still
    goes through — it just uses the configured primary.

    `model_override`, when set, takes precedence over the deep/fast routing —
    used for custom agents where Adam picked a specific model at create time."""
    cmd = [OPENCLAW_BIN, "agent", "--agent", "main", "--message", prefixed]
    if session_id:
        cmd.extend(["--session-id", session_id])
    env = os.environ.copy()
    if brain == "deep":
        cmd.extend(["--thinking", "high"])
        env["ANTHROPIC_MODEL"] = "anthropic/claude-opus-4-7"
    if model_override:
        env["ANTHROPIC_MODEL"] = model_override
    return subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=env)


@app.post("/chat")
def chat(req: ChatRequest):
    effective_mode = req.mode or "personal"
    # Credential scrub — if Tom accidentally pastes a token into the chat
    # (e.g. while we're guiding him through HubSpot) we MUST not persist it
    # to SQLite, ship it to Anthropic, or echo it back. Redact before we do
    # anything else with the message.
    message = _scrub_credentials(req.message)

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

    # Prefix for the main agent's routing. Built-in modes get the legacy
    # short prefixes the workspace AGENTS.md already understands. Custom
    # agents get an explicit "[custom-agent:<slug>]" prefix plus a SOUL.md
    # preamble so the main router has everything it needs to adopt the
    # custom persona without us touching workspace AGENTS.md per agent.
    custom_agent = None
    if effective_mode == "marketing":
        prefixed = "[marketing] " + message
    elif effective_mode == "setup":
        prefixed = "[setup] " + message
    elif effective_mode == "personal":
        prefixed = "[personal] " + message
    elif _is_custom_agent_slug(effective_mode):
        custom_agent = _read_agent(effective_mode)
        soul_md = (custom_agent or {}).get("soul_md") or ""
        # Embed the persona inline so the main agent can adopt it without
        # needing AGENTS.md routing rules updated for each new custom agent.
        prefixed = (
            f"[custom-agent:{effective_mode}] You are now operating as the "
            f"'{custom_agent['name']}' specialist. Adopt the persona, capabilities, "
            "and tool list from the SOUL.md below verbatim — it is the source of "
            "truth for this conversation.\n\n"
            "---\n"
            f"{soul_md}\n"
            "---\n\n"
            f"Adam's message: {message}"
        )
    else:
        # Unknown slug — fall back to personal so chat still works rather
        # than 500ing. The agent won't have the bespoke persona, but Adam
        # can still get a reply and route the issue.
        prefixed = "[personal] " + message
        effective_mode = "personal"

    # Setup mode is always FAST — credential walk-throughs don't benefit
    # from deep reasoning and the latency matters for a step-by-step flow.
    # Custom agents use whatever model was picked at create time.
    if effective_mode == "setup":
        brain = "fast"
    elif custom_agent:
        # Custom agent's chosen model is authoritative; we still report a
        # sensible model_used label by mapping the model key onto our two
        # broad buckets (opus → deep, anything else → fast).
        brain = "deep" if custom_agent.get("model") == "opus-4-7" else "fast"
    else:
        brain = route_to_brain(message, effective_mode)
    model_used = "opus" if brain == "deep" else "sonnet"

    model_override: Optional[str] = None
    if custom_agent:
        model_key = custom_agent.get("model") or AGENT_DEFAULT_MODEL
        model_override = AGENT_MODEL_CATALOGUE.get(model_key, {}).get("anthropic")
        # Surface the precise model in the response so the UI's BrainPill can
        # show "haiku" / "sonnet" / "opus" instead of forcing it into two buckets.
        if model_key.startswith("haiku"):
            model_used = "haiku"
        elif model_key.startswith("opus"):
            model_used = "opus"
        else:
            model_used = "sonnet"

    try:
        result = _invoke_openclaw(prefixed, brain, conv_uuid, model_override=model_override)
        if result.returncode != 0 and brain == "deep" and not custom_agent:
            # Deep failed — one retry on fast before giving up.
            # Custom agents skip this retry: their model is intentional, not a
            # heuristic, so silently downgrading would surprise Adam.
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

        # Action-marker post-processing. Setup mode never emits actions —
        # it's a credential walk-through, nothing to execute on Adam's behalf.
        needs_setup: Optional[dict] = None
        needs_api_enable: Optional[dict] = None
        if effective_mode != "setup":
            reply, needs_setup, needs_api_enable = _extract_and_register_actions(reply, conv_uuid, cur)

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

        response: dict = {
            "reply": reply,
            "mode": effective_mode,
            "conversation_id": conv_uuid,
            "model_used": model_used,
        }
        if needs_setup:
            response["needs_setup"] = needs_setup
        if needs_api_enable:
            response["needs_api_enable"] = needs_api_enable
        return response

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
def conversations_list(mode: Optional[str] = Query(None)):
    # Accept any slug (built-in `personal` / `marketing` plus any custom-agent
    # slug created via /agents/create). The slug regex below blocks anything
    # that isn't a valid identifier — protects against SQL via Pydantic-style
    # input even though we already use a parameterised query.
    if mode is not None and not re.match(r"^[a-z0-9][a-z0-9\-]{0,49}$", mode):
        raise HTTPException(status_code=400, detail="Invalid mode.")
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


# ---------------------------------------------------------------------------
# Integrations — Keychain-backed credential storage + test endpoints.
# ---------------------------------------------------------------------------
#
# Storage model
#   Service name: "mission-control-ai"
#   Username:     "{tool_id}:{field_name}"  (e.g. "hubspot:token")
#
# The UI never gets credential values back — only the list of field names
# that are present. OAuth access/refresh tokens for Google are stored under
# the same service but with well-known field names (access_token / refresh_token).
#
# Security boundary:
#   - Values NEVER hit SQLite, the workspace filesystem, or the subprocess env.
#   - Values NEVER appear in /chat responses, /config responses, or logs.
#   - All write paths go through _kc_set; all reads through _kc_get.

KEYCHAIN_SERVICE = "mission-control-ai"

_INTEGRATIONS: dict[str, dict] = {
    "google-workspace": {
        "label": "Google Workspace",
        "required_fields": ["client_id", "client_secret"],
        "all_fields": ["client_id", "client_secret", "access_token", "refresh_token", "token_expiry"],
        "oauth": True,
    },
    "hubspot": {
        "label": "HubSpot",
        "required_fields": ["token"],
        "all_fields": ["token"],
        "oauth": False,
    },
    "ghl": {
        "label": "GoHighLevel",
        "required_fields": ["api_key", "location_id"],
        "all_fields": ["api_key", "location_id"],
        "oauth": False,
    },
    "pomanda": {
        "label": "Pomanda",
        "required_fields": ["api_key"],
        "all_fields": ["api_key"],
        "oauth": False,
    },
    "cognism": {
        "label": "Cognism",
        "required_fields": ["api_key"],
        "all_fields": ["api_key"],
        "oauth": False,
    },
    "lusha": {
        "label": "Lusha",
        "required_fields": ["api_key"],
        "all_fields": ["api_key"],
        "oauth": False,
    },
    "google": {
        "label": "Google Workspace (v2)",
        "required_fields": ["client_id", "client_secret"],
        # OAuth tokens are written by /auth/google/callback, not by the
        # credentials endpoint — but we list them here so /integrations
        # status reflects whether Adam is fully connected.
        "all_fields": ["client_id", "client_secret", "access_token", "refresh_token", "expires_at", "email"],
        "oauth": True,
    },
}


def _require_tool(tool_id: str) -> dict:
    spec = _INTEGRATIONS.get(tool_id)
    if not spec:
        raise HTTPException(status_code=404, detail=f"Unknown integration '{tool_id}'.")
    return spec


def _kc_username(tool_id: str, field: str) -> str:
    return f"{tool_id}:{field}"


def _kc_set(tool_id: str, field: str, value: str) -> None:
    keyring.set_password(KEYCHAIN_SERVICE, _kc_username(tool_id, field), value)


def _kc_get(tool_id: str, field: str) -> Optional[str]:
    try:
        return keyring.get_password(KEYCHAIN_SERVICE, _kc_username(tool_id, field))
    except keyring.errors.KeyringError:
        return None


def _kc_delete(tool_id: str, field: str) -> bool:
    try:
        keyring.delete_password(KEYCHAIN_SERVICE, _kc_username(tool_id, field))
        return True
    except keyring.errors.PasswordDeleteError:
        return False  # already absent
    except keyring.errors.KeyringError:
        return False


class CredentialsPayload(BaseModel):
    credentials: dict


@app.get("/integrations")
def integrations_list():
    """List integrations with public metadata (no values)."""
    out = []
    for tid, spec in _INTEGRATIONS.items():
        stored = [f for f in spec["all_fields"] if _kc_get(tid, f)]
        required_present = all(f in stored for f in spec["required_fields"])
        out.append({
            "id": tid,
            "label": spec["label"],
            "connected": required_present,
            "fields_stored": stored,
            "required_fields": spec["required_fields"],
            "oauth": spec["oauth"],
        })
    return {"integrations": out}


@app.get("/integrations/{tool_id}/status")
def integration_status(tool_id: str):
    spec = _require_tool(tool_id)
    stored = [f for f in spec["all_fields"] if _kc_get(tool_id, f)]
    return {
        "id": tool_id,
        "label": spec["label"],
        "connected": all(f in stored for f in spec["required_fields"]),
        "fields_stored": stored,
        "required_fields": spec["required_fields"],
        "oauth": spec["oauth"],
    }


@app.post("/integrations/{tool_id}/credentials")
def integration_save(tool_id: str, payload: CredentialsPayload):
    spec = _require_tool(tool_id)
    allowed = set(spec["all_fields"])
    saved_fields: list[str] = []
    for field, value in (payload.credentials or {}).items():
        if field not in allowed:
            raise HTTPException(status_code=400, detail=f"Unknown field '{field}' for {tool_id}.")
        if not isinstance(value, str) or not value.strip():
            raise HTTPException(status_code=400, detail=f"Field '{field}' must be a non-empty string.")
        _kc_set(tool_id, field, value.strip())
        saved_fields.append(field)
    if not saved_fields:
        raise HTTPException(status_code=400, detail="No credential fields supplied.")
    # Never log values. Only field names.
    return {"saved": True, "tool_id": tool_id, "fields_saved": saved_fields}


@app.delete("/integrations/{tool_id}/credentials")
def integration_delete(tool_id: str):
    spec = _require_tool(tool_id)
    for f in spec["all_fields"]:
        _kc_delete(tool_id, f)
    return {"deleted": True, "tool_id": tool_id}


# -- Test endpoints ---------------------------------------------------------

def _http_json(method: str, url: str, *, headers: dict, body: Optional[bytes] = None, timeout: float = 8.0) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else {"error": str(e)}
        except ValueError:
            return e.code, {"error": raw.decode("utf-8", errors="replace")[:300]}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def _test_hubspot() -> dict:
    token = _kc_get("hubspot", "token")
    if not token:
        return {"success": False, "error": "No HubSpot token stored."}
    status, body = _http_json(
        "GET",
        "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
        headers={"Authorization": f"Bearer {token}"},
    )
    if status == 200:
        return {"success": True}
    if status == 401:
        return {"success": False, "error": "Token rejected (401). Re-check the Private App token."}
    if status == 403:
        return {"success": False, "error": "Forbidden (403). Scopes missing on the Private App."}
    return {"success": False, "error": body.get("message") or f"HTTP {status}"}


def _test_ghl() -> dict:
    """Verify the V2 Private Integration token against the user's Location.

    Calls GET /locations/{location_id} on services.leadconnectorhq.com — the
    cheapest read that proves both pieces of the credential are good. Tokens
    minted via Settings → Private Integrations carry a `pit-` prefix; we warn
    if it's missing but still attempt the call (the prefix isn't strictly
    enforced by the API and a future format change shouldn't break us)."""
    api_key = _kc_get("ghl", "api_key")
    location_id = _kc_get("ghl", "location_id")
    if not api_key:
        return {"success": False, "error": "API key not configured."}
    if not location_id:
        return {"success": False, "error": "Location ID not configured."}

    warning = None
    if not api_key.startswith("pit-"):
        warning = "Token doesn't start with 'pit-' — make sure you generated a Private Integration token, not a legacy v1 key."

    status, body = _http_json(
        "GET",
        f"https://services.leadconnectorhq.com/locations/{location_id}",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Version": "2021-07-28",
            "Accept": "application/json",
        },
    )
    if status == 200:
        loc = body.get("location") if isinstance(body, dict) else None
        name = loc.get("name") if isinstance(loc, dict) else None
        result = {"success": True, "location_name": name, "scopes_active": "verified"}
        if warning:
            result["warning"] = warning
        return result
    if status == 401:
        return {"success": False, "error": "Token rejected (401). Regenerate in GHL Settings → Private Integrations."}
    if status == 403:
        return {"success": False, "error": "Forbidden (403). Token is missing the locations.readonly scope."}
    if status == 404:
        return {"success": False, "error": "Location ID not found (404). Check Settings → Business Profile."}
    if status == 429:
        return {"success": False, "error": "GHL rate-limited the test (429). Try again shortly."}
    return {"success": False, "error": (body.get("message") if isinstance(body, dict) else None) or body.get("error") or f"HTTP {status}"}


def _google_refresh_access_token() -> Optional[str]:
    """Return a fresh access_token if we have a stored refresh_token; else None.

    Does not raise — callers translate None to a user-friendly error."""
    client_id = _kc_get("google-workspace", "client_id")
    client_secret = _kc_get("google-workspace", "client_secret")
    refresh = _kc_get("google-workspace", "refresh_token")
    if not (client_id and client_secret and refresh):
        return None
    form = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    }).encode("utf-8")
    status, body = _http_json(
        "POST",
        "https://oauth2.googleapis.com/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=form,
    )
    if status != 200:
        return None
    access = body.get("access_token")
    if access:
        _kc_set("google-workspace", "access_token", access)
    return access


def _test_google_workspace() -> dict:
    client_id = _kc_get("google-workspace", "client_id")
    client_secret = _kc_get("google-workspace", "client_secret")
    if not (client_id and client_secret):
        return {"success": False, "error": "Client ID / Secret not stored yet."}
    access = _google_refresh_access_token() or _kc_get("google-workspace", "access_token")
    if not access:
        return {"success": False, "error": "Not authorized yet — run the Authorize step first."}
    now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    end_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    # freebusy needs a valid range; just ask for a 1-minute window.
    body = json.dumps({
        "timeMin": now_iso,
        "timeMax": end_iso,
        "items": [{"id": "primary"}],
    }).encode("utf-8")
    status, resp = _http_json(
        "POST",
        "https://www.googleapis.com/calendar/v3/freeBusy",
        headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
        body=body,
    )
    if status == 200:
        return {"success": True}
    if status == 401:
        return {"success": False, "error": "Access token rejected — re-authorize."}
    if status == 403:
        return {"success": False, "error": "Calendar API not enabled on the project, or scope missing."}
    return {"success": False, "error": resp.get("error", {}).get("message") if isinstance(resp.get("error"), dict) else str(resp.get("error") or f"HTTP {status}")}


def _test_pomanda() -> dict:
    """Lightweight read-only probe.

    API shape is best-guess pending real-credential verification. Pomanda's
    public docs advertise an `x-api-key` header; we call a `companies` search
    with `limit=1` so the probe costs nothing interesting. If Pomanda changes
    the header name (e.g. `Authorization: Bearer`) once real keys are in hand,
    update here."""
    api_key = _kc_get("pomanda", "api_key")
    if not api_key:
        return {"success": False, "error": "No Pomanda API key stored."}
    status, body = _http_json(
        "GET",
        "https://api.pomanda.com/v1/companies?query=test&limit=1",
        headers={"x-api-key": api_key, "Accept": "application/json"},
    )
    if status == 200:
        return {"success": True}
    if status in (401, 403):
        return {"success": False, "error": f"Pomanda rejected the key ({status}). Re-check the value, or confirm the plan tier includes API access."}
    if status == 0:
        return {"success": False, "error": "Couldn't reach Pomanda. The endpoint URL may need verifying against real credentials."}
    return {"success": False, "error": body.get("message") or body.get("error") or f"HTTP {status}"}


def _test_cognism() -> dict:
    """Lightweight account probe.

    Cognism's public API is gated and evolves; `/users/me` is the commonest
    account-level endpoint that returns 200 on a valid key and 401 otherwise.
    This test does not consume enrichment credits. Verify the path once real
    keys are on hand — Cognism may expose a dedicated /account or /quota
    endpoint that's a cleaner probe."""
    api_key = _kc_get("cognism", "api_key")
    if not api_key:
        return {"success": False, "error": "No Cognism API key stored."}
    status, body = _http_json(
        "GET",
        "https://app.cognism.com/api/users/me",
        headers={"api_key": api_key, "Accept": "application/json"},
    )
    if status == 200:
        return {"success": True}
    if status in (401, 403):
        return {"success": False, "error": f"Cognism rejected the key ({status}). Admin permission is required to mint API keys — re-check who generated it."}
    if status == 0:
        return {"success": False, "error": "Couldn't reach Cognism."}
    return {"success": False, "error": body.get("message") or body.get("error") or f"HTTP {status}"}


def _test_lusha() -> dict:
    """Quota / credit-usage probe.

    Lusha v2 exposes `/v2/credits`; the call reads current credit balance and
    does not consume any. Lusha accepts the key in an `api_key` header. Verify
    once a real Premium/Scale key is available."""
    api_key = _kc_get("lusha", "api_key")
    if not api_key:
        return {"success": False, "error": "No Lusha API key stored."}
    status, body = _http_json(
        "GET",
        "https://api.lusha.com/v2/credits",
        headers={"api_key": api_key, "Accept": "application/json"},
    )
    if status == 200:
        return {"success": True}
    if status in (401, 403):
        return {"success": False, "error": f"Lusha rejected the key ({status}). Premium or Scale plan is required for API access."}
    if status == 0:
        return {"success": False, "error": "Couldn't reach Lusha."}
    return {"success": False, "error": body.get("message") or body.get("error") or f"HTTP {status}"}


_TESTERS = {
    "hubspot": _test_hubspot,
    "ghl": _test_ghl,
    "google-workspace": _test_google_workspace,
    "pomanda": _test_pomanda,
    "cognism": _test_cognism,
    "lusha": _test_lusha,
}


@app.post("/integrations/{tool_id}/test")
def integration_test(tool_id: str):
    _require_tool(tool_id)
    tester = _TESTERS.get(tool_id)
    if not tester:
        raise HTTPException(status_code=501, detail="No tester registered for this tool.")
    return tester()


# -- Google OAuth -----------------------------------------------------------
#
# Desktop-app OAuth: Google accepts `http://127.0.0.1:<port>/...` as the
# redirect URI without registration. We use the backend itself
# (http://127.0.0.1:8001/integrations/google-workspace/oauth-callback) which
# must be added as an "Authorized redirect URI" on the OAuth client.
#
# Flow:
#   1. POST /integrations/google-workspace/oauth-init
#        Returns auth_url. Frontend opens it in a popup.
#   2. User grants scopes → Google redirects to /oauth-callback?code=...
#   3. Callback exchanges code → stores refresh_token + access_token.
#      Returns a simple HTML "you can close this window" page.

from fastapi.responses import HTMLResponse  # noqa: E402

# Read scopes + the write scopes Jackson needs for confirm-to-execute actions.
# Every action still requires Adam's explicit click on a confirmation card —
# see the action-marker parser in /chat and POST /tools/execute.
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/contacts",
]
GOOGLE_REDIRECT_URI = "http://127.0.0.1:8001/integrations/google-workspace/oauth-callback"


@app.post("/integrations/google-workspace/oauth-init")
def google_oauth_init():
    client_id = _kc_get("google-workspace", "client_id")
    if not client_id:
        raise HTTPException(status_code=400, detail="Client ID not stored yet. Paste credentials first.")
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(GOOGLE_SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    })
    return {"auth_url": f"https://accounts.google.com/o/oauth2/v2/auth?{params}"}


@app.get("/integrations/google-workspace/oauth-callback", response_class=HTMLResponse)
def google_oauth_callback(code: Optional[str] = None, error: Optional[str] = None):
    def _page(msg: str, ok: bool) -> str:
        colour = "#16a34a" if ok else "#dc2626"
        return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Mission Control — Google OAuth</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#111}}h1{{font-size:18px;font-weight:500}}p{{font-size:14px;line-height:1.6;color:#555}}.badge{{display:inline-block;padding:2px 10px;border-radius:999px;background:{colour};color:#fff;font-size:12px}}</style>
</head><body>
<span class="badge">{'Connected' if ok else 'Error'}</span>
<h1>{msg}</h1>
<p>You can close this window and return to Mission Control.</p>
</body></html>"""

    if error:
        return HTMLResponse(_page(f"Google returned: {error}", ok=False), status_code=400)
    if not code:
        return HTMLResponse(_page("Missing authorization code.", ok=False), status_code=400)

    client_id = _kc_get("google-workspace", "client_id")
    client_secret = _kc_get("google-workspace", "client_secret")
    if not (client_id and client_secret):
        return HTMLResponse(_page("Client ID / Secret not stored.", ok=False), status_code=400)

    form = urllib.parse.urlencode({
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode("utf-8")
    status, body = _http_json(
        "POST",
        "https://oauth2.googleapis.com/token",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=form,
    )
    if status != 200:
        msg = (body.get("error_description") or body.get("error") or f"HTTP {status}")
        return HTMLResponse(_page(f"Token exchange failed: {msg}", ok=False), status_code=400)

    access = body.get("access_token")
    refresh = body.get("refresh_token")
    if not access:
        return HTMLResponse(_page("No access_token in Google response.", ok=False), status_code=400)
    _kc_set("google-workspace", "access_token", access)
    if refresh:
        _kc_set("google-workspace", "refresh_token", refresh)
    return HTMLResponse(_page("Connected successfully.", ok=True))


# ---------------------------------------------------------------------------
# Google Workspace v2 — single OAuth client, five services.
# ---------------------------------------------------------------------------
#
# Distinct namespace from the legacy `google-workspace` integration above:
#   - Tool ID: "google" (vs "google-workspace")
#   - Keychain prefix: google:* (vs google-workspace:*)
#   - Redirect URI: /auth/google/callback (vs /integrations/google-workspace/oauth-callback)
#
# The two coexist while we migrate the inline gmail.send / calendar.create_event
# / drive.create_doc / contacts.create executors over to per-service modules.
# Adam can have either flow set up without conflict.

# Credentials surface for "google" piggybacks on the standard
# /integrations/{tool_id}/credentials handler — the _INTEGRATIONS entry above
# defines client_id + client_secret as required fields, and the SetupModal
# already POSTs `{credentials: {client_id, client_secret}}` there. Token
# fields (access/refresh/expires/email) are written by /auth/google/callback.

@app.post("/integrations/google/disconnect")
def google_disconnect():
    """Sign out without losing the OAuth client config — Adam keeps the
    Cloud Console client around but revokes the current session."""
    google_oauth.disconnect()
    return {"disconnected": True}


@app.get("/auth/google/start")
def google_auth_start():
    """Build the consent URL and hand it back to the SetupModal so it can
    open the browser. We return JSON instead of a 302 — that lets the modal
    show a "Continue in your browser" button rather than navigating the
    main app away from itself."""
    if not google_oauth.has_client_credentials():
        raise HTTPException(status_code=400, detail="Save client_id and client_secret first.")
    state = google_oauth.issue_state()
    url = google_oauth.build_auth_url(state)
    if not url:
        raise HTTPException(status_code=500, detail="Could not build auth URL.")
    return {"auth_url": url, "state": state}


@app.get("/auth/google/callback", response_class=HTMLResponse)
def google_auth_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    """Receive the authorization code from Google, exchange for tokens, and
    render an auto-close success page. The SetupModal is concurrently polling
    /auth/google/status so the UI flips to Connected without needing this
    page to talk to it directly."""
    def _page(msg: str, ok: bool) -> str:
        colour = "#16a34a" if ok else "#dc2626"
        return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Mission Control — Google sign-in</title>
<style>body{{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#111}}h1{{font-size:18px;font-weight:500}}p{{font-size:14px;line-height:1.6;color:#555}}.badge{{display:inline-block;padding:2px 10px;border-radius:999px;background:{colour};color:#fff;font-size:12px}}</style>
<script>setTimeout(() => {{ try {{ window.close(); }} catch (_) {{}} }}, 1500);</script>
</head><body>
<span class="badge">{'Connected' if ok else 'Error'}</span>
<h1>{msg}</h1>
<p>You can close this window and return to Mission Control.</p>
</body></html>"""

    if error:
        return HTMLResponse(_page(f"Google returned: {error}", ok=False), status_code=400)
    if not code:
        return HTMLResponse(_page("Missing authorization code.", ok=False), status_code=400)
    if not google_oauth.consume_state(state or ""):
        # State mismatch — refuse the code rather than risk a CSRF-style
        # confusion attack stitching someone else's grant onto this backend.
        return HTMLResponse(_page("State mismatch — please retry sign-in.", ok=False), status_code=400)

    result = google_oauth.exchange_code_for_tokens(code)
    if not result.get("success"):
        return HTMLResponse(_page(f"Token exchange failed: {result.get('error')}", ok=False), status_code=400)

    email = result.get("email") or "your account"
    return HTMLResponse(_page(f"Connected as {email}.", ok=True))


@app.get("/auth/google/status")
def google_auth_status():
    return google_oauth.get_status()


# ---------------------------------------------------------------------------
# Tool-calling — Phase 1: confirmation-first actions.
# ---------------------------------------------------------------------------
#
# The golden rule, encoded in the code path:
#   Jackson never executes. He PROPOSES.
#
# Flow:
#   1. Jackson's reply contains ```action:<type>\n{json}\n```
#   2. /chat parses the marker, creates a pending_actions row, replaces
#      the marker with [[action-card:<token>]] in the persisted/returned text.
#   3. The frontend renders an action card with a Confirm button.
#   4. Only when Adam clicks Confirm does POST /tools/execute fire.
#   5. Execution result is written to audit_log regardless of outcome.
#
# A hallucinated marker with invalid JSON is left as-is in the text — no row
# gets created, so no confirmation is possible.
#
# Action types allowlist — only these can become pending rows. Adding a new
# type later means registering it here + adding an executor below.

PENDING_ACTION_TTL_SECONDS = 3600  # 1 hour; mirrors the UI's expectation.

_ACTION_MARKER_RE = re.compile(
    r"```action:([a-z][a-z0-9_.]{1,40})\s*\n(.*?)\n```",
    re.DOTALL,
)

# Per-type validation rules. Each validator returns (normalised_data, None)
# on success or (None, error_message) — the error is discarded at parse time
# (we don't want to surface raw parse errors to Adam) and the marker is left
# in the text so Jackson can be corrected in the next turn if needed.
def _validate_gmail_send(data: dict) -> tuple[Optional[dict], Optional[str]]:
    to = (data.get("to") or "").strip()
    subject = (data.get("subject") or "").strip()
    body = (data.get("body") or "").strip()
    if not to:
        return None, "Missing 'to'."
    if "@" not in to or " " in to:
        return None, "Invalid recipient address."
    if not subject:
        return None, "Missing 'subject'."
    if not body:
        return None, "Missing 'body'."
    return {"to": to, "subject": subject, "body": body}, None


# Accept ISO 8601 local datetime (no offset): YYYY-MM-DDTHH:MM:SS with optional
# fractional seconds. Explicitly reject trailing Z or ±HH:MM — Google Calendar
# needs dateTime paired with a timeZone string, not an already-offset datetime.
_ISO_LOCAL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$")
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _validate_calendar_create_event(data: dict) -> tuple[Optional[dict], Optional[str]]:
    summary = (data.get("summary") or "").strip()
    start = (data.get("start") or "").strip()
    end = (data.get("end") or "").strip()
    if not summary:
        return None, "Missing 'summary'."
    if not start or not _ISO_LOCAL_RE.match(start):
        return None, "Missing or malformed 'start' (expect YYYY-MM-DDTHH:MM:SS local time)."
    if not end or not _ISO_LOCAL_RE.match(end):
        return None, "Missing or malformed 'end' (expect YYYY-MM-DDTHH:MM:SS local time)."
    # Parse to catch nonsense like end < start.
    try:
        start_dt = datetime.fromisoformat(start)
        end_dt = datetime.fromisoformat(end)
    except ValueError:
        return None, "Unparseable datetime."
    if end_dt <= start_dt:
        return None, "'end' must be after 'start'."

    normalised: dict = {"summary": summary, "start": start, "end": end}

    tz = (data.get("timezone") or "").strip()
    normalised["timezone"] = tz or "Europe/London"

    description = data.get("description")
    if isinstance(description, str) and description.strip():
        normalised["description"] = description.strip()

    location = data.get("location")
    if isinstance(location, str) and location.strip():
        normalised["location"] = location.strip()

    attendees = data.get("attendees")
    if isinstance(attendees, list):
        cleaned: list[str] = []
        for item in attendees:
            if isinstance(item, str) and _EMAIL_RE.match(item.strip()):
                cleaned.append(item.strip())
        if cleaned:
            normalised["attendees"] = cleaned

    return normalised, None


# Allowed Drive MIME types — Phase 3 only supports two shapes: Google Doc
# (rendered from plain/HTML content) and plain text. Anything else is
# rejected so we don't silently upload binaries.
_ALLOWED_DRIVE_MIME = {
    "application/vnd.google-apps.document",
    "text/plain",
}


def _validate_drive_create_doc(data: dict) -> tuple[Optional[dict], Optional[str]]:
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "Missing 'name'."
    content = data.get("content")
    if not isinstance(content, str):
        return None, "'content' must be a string."

    normalised: dict = {"name": name.strip(), "content": content}

    mime = data.get("mime_type")
    if mime is None or mime == "":
        normalised["mime_type"] = "application/vnd.google-apps.document"
    elif isinstance(mime, str) and mime in _ALLOWED_DRIVE_MIME:
        normalised["mime_type"] = mime
    else:
        return None, f"Unsupported 'mime_type' (allowed: {sorted(_ALLOWED_DRIVE_MIME)})."

    folder = data.get("folder_id")
    if isinstance(folder, str) and folder.strip():
        normalised["folder_id"] = folder.strip()

    return normalised, None


def _validate_contacts_create(data: dict) -> tuple[Optional[dict], Optional[str]]:
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return None, "Missing 'name'."

    normalised: dict = {"name": name.strip()}

    email = data.get("email")
    if email not in (None, ""):
        if not isinstance(email, str) or not _EMAIL_RE.match(email.strip()):
            return None, f"Invalid email: {email!r}."
        normalised["email"] = email.strip()

    for field in ("phone", "company", "notes"):
        v = data.get(field)
        if isinstance(v, str) and v.strip():
            normalised[field] = v.strip()

    return normalised, None


def _validate_ghl_create_contact(data: dict) -> tuple[Optional[dict], Optional[str]]:
    """Confirmation-required: pushes a contact into GHL. Mirrors the shape
    Jackson emits — at least one of name/firstName/email must be present so
    we don't write empty rows. `locationId` is intentionally NOT accepted
    here; the executor injects it from Keychain."""
    first = (data.get("firstName") or data.get("first_name") or "").strip()
    last = (data.get("lastName") or data.get("last_name") or "").strip()
    name = (data.get("name") or "").strip()
    email = (data.get("email") or "").strip()
    phone = (data.get("phone") or "").strip()

    if not (first or last or name or email):
        return None, "Need at least a name or email."
    if email and not _EMAIL_RE.match(email):
        return None, f"Invalid email: {email!r}."

    normalised: dict = {}
    if first:
        normalised["firstName"] = first
    if last:
        normalised["lastName"] = last
    if name:
        normalised["name"] = name
    if email:
        normalised["email"] = email
    if phone:
        normalised["phone"] = phone

    company = (data.get("companyName") or data.get("company") or "").strip()
    if company:
        normalised["companyName"] = company

    for k_in, k_out in (
        ("address1", "address1"), ("city", "city"), ("state", "state"),
        ("country", "country"), ("postalCode", "postalCode"),
        ("postal_code", "postalCode"), ("website", "website"),
        ("source", "source"),
    ):
        v = data.get(k_in)
        if isinstance(v, str) and v.strip():
            normalised[k_out] = v.strip()

    tags = data.get("tags")
    if isinstance(tags, list):
        cleaned = [t.strip() for t in tags if isinstance(t, str) and t.strip()]
        if cleaned:
            normalised["tags"] = cleaned

    return normalised, None


# Allowed update fields on a GHL contact. Anything else is dropped silently
# rather than rejected outright — keeps Jackson's hallucinations safe instead
# of making them surface as a confusing validation error to Adam.
_GHL_CONTACT_UPDATE_FIELDS = {
    "firstName", "lastName", "name", "email", "phone", "companyName",
    "address1", "city", "state", "country", "postalCode", "website",
    "source",
}

_GHL_CONTACT_UPDATE_ALIASES = {
    "first_name": "firstName",
    "last_name": "lastName",
    "company": "companyName",
    "company_name": "companyName",
    "postal_code": "postalCode",
}


def _validate_ghl_update_contact(data: dict) -> tuple[Optional[dict], Optional[str]]:
    """Validate args for `ghl.update_contact`.

    Required: contact_id, plus an `updates` dict carrying at least one
    allowed field. We translate snake_case aliases (`first_name` →
    `firstName`) so Jackson can emit either shape."""
    contact_id = (data.get("contact_id") or data.get("contactId") or "").strip()
    if not contact_id:
        return None, "Missing 'contact_id'."

    updates_raw = data.get("updates")
    if not isinstance(updates_raw, dict) or not updates_raw:
        return None, "Missing or empty 'updates'."

    cleaned: dict = {}
    for key, value in updates_raw.items():
        canonical = _GHL_CONTACT_UPDATE_ALIASES.get(key, key)
        if canonical not in _GHL_CONTACT_UPDATE_FIELDS:
            continue
        if isinstance(value, str) and value.strip():
            cleaned[canonical] = value.strip()

    tags = updates_raw.get("tags")
    if isinstance(tags, list):
        tag_list = [t.strip() for t in tags if isinstance(t, str) and t.strip()]
        if tag_list:
            cleaned["tags"] = tag_list

    if cleaned.get("email") and not _EMAIL_RE.match(cleaned["email"]):
        return None, f"Invalid email: {cleaned['email']!r}."

    if not cleaned:
        return None, "No supported fields in 'updates'."

    return {"contact_id": contact_id, "updates": cleaned}, None


def _validate_ghl_send_message(data: dict) -> tuple[Optional[dict], Optional[str]]:
    """Validate args for `ghl.send_message`.

    Required: contact_id, message_type ('SMS' or 'Email'), body. Subject is
    required for Email and rejected (silently dropped) on SMS so Jackson
    can't accidentally leak a draft subject into a text message."""
    contact_id = (data.get("contact_id") or data.get("contactId") or "").strip()
    if not contact_id:
        return None, "Missing 'contact_id'."

    mtype = (data.get("message_type") or data.get("type") or "").strip()
    if mtype.lower() == "sms":
        mtype = "SMS"
    elif mtype.lower() == "email":
        mtype = "Email"
    if mtype not in ("SMS", "Email"):
        return None, "message_type must be 'SMS' or 'Email'."

    body = (data.get("body") or data.get("message") or "").strip()
    if not body:
        return None, "Missing 'body'."
    if len(body) > 5000:
        return None, "Body exceeds 5000 characters."

    normalised: dict = {
        "contact_id": contact_id,
        "message_type": mtype,
        "body": body,
    }

    if mtype == "Email":
        subject = (data.get("subject") or "").strip()
        if not subject:
            return None, "Email requires a 'subject'."
        normalised["subject"] = subject

    return normalised, None


def _validate_ghl_add_note(data: dict) -> tuple[Optional[dict], Optional[str]]:
    """Validate args for `ghl.add_note`. Required: contact_id + non-empty body."""
    contact_id = (data.get("contact_id") or data.get("contactId") or "").strip()
    if not contact_id:
        return None, "Missing 'contact_id'."

    body = (data.get("body") or data.get("note") or "").strip()
    if not body:
        return None, "Missing 'body'."
    if len(body) > 5000:
        return None, "Body exceeds 5000 characters."

    return {"contact_id": contact_id, "body": body}, None


# --- Google Workspace v2 validators -----------------------------------------
#
# Mirror the existing single-service validators (gmail.send, calendar.create_event)
# but namespaced under `google.*` so they can coexist with the legacy executors
# during the migration window.

def _validate_google_calendar_create_event(data: dict) -> tuple[Optional[dict], Optional[str]]:
    summary = (data.get("summary") or "").strip()
    start = (data.get("start") or "").strip()
    end = (data.get("end") or "").strip()
    if not summary:
        return None, "Missing 'summary'."
    if not start or not _ISO_LOCAL_RE.match(start):
        return None, "Missing or malformed 'start' (expect YYYY-MM-DDTHH:MM:SS local time)."
    if not end or not _ISO_LOCAL_RE.match(end):
        return None, "Missing or malformed 'end' (expect YYYY-MM-DDTHH:MM:SS local time)."
    try:
        if datetime.fromisoformat(end) <= datetime.fromisoformat(start):
            return None, "'end' must be after 'start'."
    except ValueError:
        return None, "Unparseable datetime."

    out: dict = {
        "summary": summary,
        "start": start,
        "end": end,
        "timezone": (data.get("timezone") or "Europe/London").strip() or "Europe/London",
    }
    desc = data.get("description")
    if isinstance(desc, str) and desc.strip():
        out["description"] = desc.strip()
    loc = data.get("location")
    if isinstance(loc, str) and loc.strip():
        out["location"] = loc.strip()
    attendees = data.get("attendees")
    if isinstance(attendees, list):
        cleaned = [a.strip() for a in attendees if isinstance(a, str) and _EMAIL_RE.match(a.strip())]
        if cleaned:
            out["attendees"] = cleaned
    return out, None


def _validate_google_gmail_send(data: dict) -> tuple[Optional[dict], Optional[str]]:
    to = (data.get("to") or "").strip()
    subject = (data.get("subject") or "").strip()
    body = (data.get("body") or "").strip()
    if not to or "@" not in to:
        return None, "Invalid 'to'."
    if not subject:
        return None, "Missing 'subject'."
    if not body:
        return None, "Missing 'body'."
    out: dict = {"to": to, "subject": subject, "body": body}
    cc = (data.get("cc") or "").strip()
    bcc = (data.get("bcc") or "").strip()
    if cc:
        out["cc"] = cc
    if bcc:
        out["bcc"] = bcc
    return out, None


def _validate_google_drive_create_file(data: dict) -> tuple[Optional[dict], Optional[str]]:
    """Minimal Drive create — title + optional plain-text content. We route
    through the Docs surface for actual content creation (richer + same auth)."""
    name = (data.get("name") or data.get("title") or "").strip()
    if not name:
        return None, "Missing 'name'."
    out: dict = {"name": name}
    content = data.get("content")
    if isinstance(content, str):
        out["content"] = content
    folder = data.get("folder_id")
    if isinstance(folder, str) and folder.strip():
        out["folder_id"] = folder.strip()
    return out, None


def _validate_google_sheets_append(data: dict) -> tuple[Optional[dict], Optional[str]]:
    sid = (data.get("spreadsheet_id") or "").strip()
    if not sid:
        return None, "Missing 'spreadsheet_id'."
    rng = (data.get("range") or "Sheet1!A:Z").strip()
    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        return None, "Missing 'rows' (list of lists)."
    cleaned: list[list] = []
    for row in rows:
        if isinstance(row, list):
            cleaned.append(row)
        elif isinstance(row, str):
            cleaned.append([row])
    if not cleaned:
        return None, "No usable rows."
    return {"spreadsheet_id": sid, "range": rng, "rows": cleaned}, None


def _validate_google_sheets_create(data: dict) -> tuple[Optional[dict], Optional[str]]:
    title = (data.get("title") or "").strip()
    if not title:
        return None, "Missing 'title'."
    return {"title": title}, None


def _validate_google_docs_create(data: dict) -> tuple[Optional[dict], Optional[str]]:
    title = (data.get("title") or "").strip()
    if not title:
        return None, "Missing 'title'."
    out: dict = {"title": title}
    content = data.get("content")
    if isinstance(content, str):
        out["content"] = content
    return out, None


def _validate_google_docs_update(data: dict) -> tuple[Optional[dict], Optional[str]]:
    doc_id = (data.get("doc_id") or data.get("document_id") or "").strip()
    if not doc_id:
        return None, "Missing 'doc_id'."
    content = data.get("content")
    if not isinstance(content, str):
        return None, "Missing 'content' (string)."
    return {"doc_id": doc_id, "content": content}, None


_ACTION_VALIDATORS = {
    "gmail.send": _validate_gmail_send,
    "calendar.create_event": _validate_calendar_create_event,
    "drive.create_doc": _validate_drive_create_doc,
    "contacts.create": _validate_contacts_create,
    "ghl.create_contact": _validate_ghl_create_contact,
    "google.calendar_create_event": _validate_google_calendar_create_event,
    "google.gmail_send":             _validate_google_gmail_send,
    "google.drive_create_file":      _validate_google_drive_create_file,
    "google.sheets_append":          _validate_google_sheets_append,
    "google.sheets_create":          _validate_google_sheets_create,
    "google.docs_create":            _validate_google_docs_create,
    "google.docs_update":            _validate_google_docs_update,
    "ghl.update_contact": _validate_ghl_update_contact,
    "ghl.send_message": _validate_ghl_send_message,
    "ghl.add_note": _validate_ghl_add_note,
}


def _expire_old_pending_actions(cur: sqlite3.Cursor) -> None:
    """Flip any pending rows older than the TTL to 'expired'. Cheap — runs
    once per /chat call, indexed on (status, created_at)."""
    cutoff = (datetime.utcnow() - timedelta(seconds=PENDING_ACTION_TTL_SECONDS)).isoformat(sep=" ", timespec="seconds")
    cur.execute(
        "UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND created_at < ?",
        (cutoff,),
    )


# ---------------------------------------------------------------------------
# Read-only actions — execute inline, no confirmation card.
# ---------------------------------------------------------------------------
#
# `action:ghl.search_contacts`, `action:ghl.list_*` and similar lookups don't
# touch GHL state. There's no value in routing them through the pending_action
# table — Adam doesn't need to confirm a search. Instead, the marker parser
# executes them immediately and replaces the marker with a small markdown
# block that becomes part of Jackson's reply (and therefore part of the
# conversation history Jackson reads on the next turn — that's how he gets
# from "find Sarah" to "send Sarah a message").
#
# A read handler returns the substitute markdown string. Failures still
# produce a string ("> Couldn't reach GHL: …") rather than crashing the
# whole reply — leaving the marker behind would confuse Adam.

def _truncate(text: Optional[str], n: int = 80) -> str:
    s = (text or "").strip().replace("\n", " ")
    return (s[: n - 1] + "…") if len(s) > n else s


# Each read handler returns (markdown, needs_setup_or_None). The text is
# spliced into Jackson's reply; needs_setup (when present) bubbles up to the
# /chat response so the frontend can auto-open SetupModal.
def _read_ghl_search_contacts(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    query = (args.get("query") or "").strip()
    try:
        limit = int(args.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 50))
    res = ghl.list_contacts(query=query or None, limit=limit)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        msg = (
            "> _GHL isn't connected yet — I'll show you how to set it up._"
            if needs
            else f"> _GHL search failed: {res['error']}_"
        )
        return msg, needs, None
    contacts = res.get("contacts") or []
    if not contacts:
        return f"> _No GHL contacts found for `{query or '(any)'}`._", None, None
    lines = [f"**GHL contacts matching `{query}`** ({len(contacts)}):" if query
             else f"**Recent GHL contacts** ({len(contacts)}):"]
    for c in contacts:
        nm = c.get("name") or " ".join(filter(None, [c.get("first_name"), c.get("last_name")])).strip() or "(no name)"
        bits = [b for b in (c.get("email"), c.get("phone"), c.get("company")) if b]
        meta = " · ".join(bits)
        lines.append(f"- **{nm}** — {meta or '_no contact info_'} `id:{c.get('id')}`")
    return "\n".join(lines), None, None


def _read_ghl_list_opportunities(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    pipeline_id = args.get("pipeline_id") or None
    try:
        limit = int(args.get("limit") or 20)
    except (TypeError, ValueError):
        limit = 20
    limit = max(1, min(limit, 50))
    res = ghl.list_opportunities(pipeline_id=pipeline_id, limit=limit)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        msg = (
            "> _GHL isn't connected yet — I'll show you how to set it up._"
            if needs
            else f"> _GHL opportunities lookup failed: {res['error']}_"
        )
        return msg, needs, None
    opps = res.get("opportunities") or []
    if not opps:
        return "> _No GHL opportunities found._", None, None
    lines = [f"**GHL opportunities** ({len(opps)}):"]
    for o in opps:
        money = o.get("monetary_value")
        money_str = f"£{money:,.0f}" if isinstance(money, (int, float)) else ""
        contact = o.get("contact_name") or ""
        status = o.get("status") or ""
        bits = " · ".join(filter(None, [contact, status, money_str]))
        lines.append(f"- **{o.get('name') or '(unnamed)'}** {('— ' + bits) if bits else ''} `id:{o.get('id')}`")
    return "\n".join(lines), None, None


def _read_ghl_list_conversations(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    contact_id = args.get("contact_id") or None
    try:
        limit = int(args.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 50))
    res = ghl.list_conversations(contact_id=contact_id, limit=limit)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        msg = (
            "> _GHL isn't connected yet — I'll show you how to set it up._"
            if needs
            else f"> _GHL conversations lookup failed: {res['error']}_"
        )
        return msg, needs, None
    convos = res.get("conversations") or []
    if not convos:
        return "> _No GHL conversations found._", None, None
    lines = [f"**Recent GHL conversations** ({len(convos)}):"]
    for c in convos:
        nm = c.get("contact_name") or "(unknown)"
        last = _truncate(c.get("last_message_body"), 100) or "_(empty)_"
        unread = c.get("unread_count") or 0
        unread_tag = f" · {unread} unread" if unread else ""
        lines.append(f"- **{nm}**{unread_tag}: {last} `id:{c.get('id')}`")
    return "\n".join(lines), None, None


def _read_ghl_list_calendar_events(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    calendar_id = (args.get("calendar_id") or "").strip()
    start = args.get("start")
    end = args.get("end")
    if not calendar_id:
        cal_res = ghl.list_calendars()
        if cal_res.get("needs_setup"):
            return "> _GHL isn't connected yet — I'll show you how to set it up._", cal_res["needs_setup"], None
        cals = cal_res.get("calendars") or []
        if not cals:
            return "> _No GHL calendars configured._", None, None
        calendar_id = cals[0]["id"]
    res = ghl.list_calendar_events(calendar_id, start=start, end=end)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        msg = (
            "> _GHL isn't connected yet — I'll show you how to set it up._"
            if needs
            else f"> _GHL calendar lookup failed: {res['error']}_"
        )
        return msg, needs, None
    events = res.get("events") or []
    if not events:
        return "> _No GHL events in that range._", None, None
    lines = [f"**GHL events** ({len(events)}):"]
    for e in events:
        rng = " → ".join(filter(None, [e.get("start"), e.get("end")]))
        lines.append(f"- **{e.get('title') or '(untitled)'}** — {rng or '_no time_'} `id:{e.get('id')}`")
    return "\n".join(lines), None, None


# --- Google Workspace read handlers ----------------------------------------
#
# All return (markdown_summary, needs_setup_or_None). `needs_setup` bubbles up
# through _extract_and_register_actions so the chat layer can pop SetupModal
# in place of a generic "Google not connected" line.

def _google_disconnected_msg() -> str:
    return "> _Google isn't connected yet — I'll show you how to set it up._"


def _read_google_calendar_list_events(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    res = google_calendar.list_events(
        time_min=args.get("time_min"),
        time_max=args.get("time_max"),
        max_results=args.get("max_results") or 20,
    )
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Calendar lookup failed: {res['error']}_"), needs, api
    events = res.get("events") or []
    if not events:
        return "> _No upcoming events found._", None, None
    lines = [f"**Calendar events** ({len(events)}):"]
    for e in events:
        when = " → ".join(filter(None, [e.get("start"), e.get("end")]))
        lines.append(f"- **{e.get('summary') or '(untitled)'}** — {when or '_no time_'} `id:{e.get('id')}`")
    return "\n".join(lines), None, None


def _read_google_gmail_list_messages(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    query = (args.get("query") or "is:inbox").strip()
    max_results = args.get("max_results") or 10
    res = google_gmail.list_messages(query=query, max_results=max_results)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Gmail lookup failed: {res['error']}_"), needs, api
    msgs = res.get("messages") or []
    if not msgs:
        return f"> _No messages match `{query}`._", None, None
    lines = [f"**Gmail — `{query}`** ({len(msgs)}):"]
    for m in msgs:
        sender = (m.get("from") or "").split("<")[0].strip() or m.get("from") or "(unknown)"
        snippet = (m.get("snippet") or "").strip().replace("\n", " ")[:100]
        lines.append(f"- **{m.get('subject') or '(no subject)'}** — {sender}: {snippet} `id:{m.get('id')}`")
    return "\n".join(lines), None, None


def _read_google_gmail_get_message(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    mid = (args.get("message_id") or "").strip()
    if not mid:
        return "> _Need a `message_id` to fetch the full email._", None, None
    res = google_gmail.get_message(mid)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Gmail fetch failed: {res['error']}_"), needs, api
    m = res.get("message") or {}
    body = (m.get("body_text") or "").strip()
    if len(body) > 1500:
        body = body[:1500] + "\n…(truncated)"
    return (
        f"**{m.get('subject') or '(no subject)'}**\n"
        f"From: {m.get('from')}\nDate: {m.get('date')}\n\n{body or '_(no plain-text body)_'}",
        None,
        None,
    )  # text, needs_setup, needs_api_enable


def _read_google_drive_list_files(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    query = args.get("query")
    max_results = args.get("max_results") or 20
    res = google_drive.list_files(query=query, max_results=max_results)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Drive lookup failed: {res['error']}_"), needs, api
    files = res.get("files") or []
    if not files:
        return "> _No matching Drive files._", None, None
    lines = [f"**Drive files** ({len(files)}):"]
    for f in files:
        kind = (f.get("mime_type") or "").split(".")[-1].split("/")[-1]
        lines.append(f"- **{f.get('name') or '(unnamed)'}** ({kind}) — modified {f.get('modified_time') or '?'} `id:{f.get('id')}`")
    return "\n".join(lines), None, None


def _read_google_drive_search(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    name = (args.get("name_contains") or args.get("query") or "").strip()
    if not name:
        return "> _Need a search term._", None, None
    res = google_drive.search_files(name, max_results=args.get("max_results") or 20)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Drive search failed: {res['error']}_"), needs, api
    files = res.get("files") or []
    if not files:
        return f"> _No Drive files match `{name}`._", None, None
    lines = [f"**Drive search `{name}`** ({len(files)}):"]
    for f in files:
        lines.append(f"- **{f.get('name') or '(unnamed)'}** — `id:{f.get('id')}`")
    return "\n".join(lines), None, None


def _read_google_sheets_read(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    sid = (args.get("spreadsheet_id") or "").strip()
    rng = (args.get("range") or "A1:Z100").strip()
    if not sid:
        return "> _Need a `spreadsheet_id` to read._", None, None
    res = google_sheets.read_range(sid, range=rng)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Sheets read failed: {res['error']}_"), needs, api
    values = res.get("values") or []
    if not values:
        return f"> _No data in `{rng}`._", None, None
    # Render up to first 20 rows × 6 cols as a markdown table.
    head = values[0] if values else []
    rows = values[1:21] if len(values) > 1 else []
    cols = max(len(r) for r in values[:21])
    cols = min(cols, 6)
    md = ["| " + " | ".join((head + [""] * cols)[:cols] or [""] * cols) + " |"]
    md.append("| " + " | ".join(["---"] * cols) + " |")
    for r in rows:
        md.append("| " + " | ".join((r + [""] * cols)[:cols]) + " |")
    if len(values) > 21:
        md.append(f"_…and {len(values) - 21} more rows._")
    return f"**{res.get('range') or rng}**\n" + "\n".join(md), None, None


def _read_google_docs_get(args: dict) -> tuple[str, Optional[dict], Optional[dict]]:
    did = (args.get("doc_id") or "").strip()
    if not did:
        return "> _Need a `doc_id` to read._", None, None
    res = google_docs.get_doc(did)
    needs = res.get("needs_setup")
    api = res.get("needs_api_enable")
    if res.get("error"):
        return (_google_disconnected_msg() if needs else f"> _Docs read failed: {res['error']}_"), needs, api
    content = (res.get("content") or "").strip()
    if len(content) > 1500:
        content = content[:1500] + "\n…(truncated)"
    return (
        f"**{res.get('title') or '(untitled)'}**\n\n{content or '_(empty doc)_'}",
        None,
    None,
    )


_READ_ACTION_HANDLERS = {
    "ghl.search_contacts": _read_ghl_search_contacts,
    "ghl.list_opportunities": _read_ghl_list_opportunities,
    "ghl.list_conversations": _read_ghl_list_conversations,
    "ghl.list_calendar_events": _read_ghl_list_calendar_events,
    "google.calendar_list_events": _read_google_calendar_list_events,
    "google.gmail_list_messages":  _read_google_gmail_list_messages,
    "google.gmail_get_message":    _read_google_gmail_get_message,
    "google.drive_list_files":     _read_google_drive_list_files,
    "google.drive_search":         _read_google_drive_search,
    "google.sheets_read":          _read_google_sheets_read,
    "google.docs_get":             _read_google_docs_get,
}


def _extract_and_register_actions(
    reply: str,
    conv_uuid: Optional[str],
    cur: sqlite3.Cursor,
) -> tuple[str, Optional[dict], Optional[dict]]:
    """Walk Jackson's reply, dispatch each ```action:<type>``` block.

    Read-only types (`ghl.search_contacts`, `ghl.list_*`) execute inline and
    are replaced with a markdown summary. Write types create a pending_actions
    row and become `[[action-card:<token>]]`.

    Returns `(rewritten_reply, needs_setup, needs_api_enable)`. Either signal
    can be present independently — needs_setup means OAuth/credentials aren't
    configured (pop SetupModal); needs_api_enable means OAuth worked but the
    specific Google API isn't enabled in Cloud Console (show inline banner
    with activation link). They're mutually exclusive in practice but the
    parser doesn't enforce that.

    Invalid JSON or unknown type → marker stays in place (no row created).
    This keeps hallucinations harmless: without a row, the UI can't render
    a card and Adam can't confirm a ghost action."""
    if not reply or "```action:" not in reply:
        return reply, None, None

    _expire_old_pending_actions(cur)

    needs_setup_signals: list[dict] = []
    needs_api_enable_signals: list[dict] = []

    def replace(match: re.Match) -> str:
        action_type = match.group(1).strip()
        raw_json = match.group(2).strip()

        # Parse JSON once and reuse for either path.
        try:
            data = json.loads(raw_json) if raw_json else {}
        except (ValueError, TypeError):
            return match.group(0)
        if not isinstance(data, dict):
            return match.group(0)

        # Read-only fast path — no validator, no pending row, no confirmation.
        read_handler = _READ_ACTION_HANDLERS.get(action_type)
        if read_handler:
            try:
                text, needs, api_enable = read_handler(data)
            except Exception as exc:  # noqa: BLE001
                return f"> _GHL read failed: {exc}_"
            if needs:
                needs_setup_signals.append(needs)
            if api_enable:
                needs_api_enable_signals.append(api_enable)
            return text

        validator = _ACTION_VALIDATORS.get(action_type)
        if not validator:
            return match.group(0)  # leave untouched — unknown action type
        normalised, err = validator(data)
        if err or normalised is None:
            return match.group(0)
        token = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO pending_actions
              (id, conversation_id, action_type, action_data_json, status)
            VALUES (?, ?, ?, ?, 'pending')
            """,
            (token, conv_uuid, action_type, json.dumps(normalised)),
        )
        return f"[[action-card:{token}]]"

    rewritten = _ACTION_MARKER_RE.sub(replace, reply)
    needs_setup = _merge_needs_setup(needs_setup_signals) if needs_setup_signals else None
    # Multiple read actions hitting different disabled APIs in one reply is
    # vanishingly rare — surface the first one. The user enables, retries,
    # and (if a second was missing) gets the same banner for the next API.
    needs_api_enable = needs_api_enable_signals[0] if needs_api_enable_signals else None
    return rewritten, needs_setup, needs_api_enable


def _merge_needs_setup(signals: list[dict]) -> Optional[dict]:
    """Combine multiple read-handler needs_setup payloads into one.

    De-dupes the tools list while preserving order. Uses the first signal's
    `context` — multiple read actions for the same tool in one reply are
    rare, and the first context is the most representative."""
    if not signals:
        return None
    tools: list[str] = []
    seen: set[str] = set()
    for s in signals:
        for t in s.get("tools") or []:
            if t and t not in seen:
                tools.append(t)
                seen.add(t)
    if not tools:
        return None
    context = signals[0].get("context") or ""
    return {"tools": tools, "context": context}


# -- Executors --------------------------------------------------------------
#
# Each executor returns (success: bool, result_or_error: dict). Executors
# never touch the pending_actions table — that's orchestrated by the endpoint.
# They also never touch Keychain writes except when refreshing an access token
# via the existing _google_refresh_access_token helper.

def _execute_gmail_send(action_data: dict) -> tuple[bool, dict]:
    access = _kc_get("google-workspace", "access_token")
    if not access:
        access = _google_refresh_access_token()
    if not access:
        return False, {"error": "Google Workspace not connected — no access token."}

    def _send(tok: str) -> tuple[int, dict]:
        msg = MIMEText(action_data["body"], _charset="utf-8")
        msg["to"] = action_data["to"]
        msg["subject"] = action_data["subject"]
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
        body = json.dumps({"raw": raw}).encode("utf-8")
        return _http_json(
            "POST",
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
            body=body,
            timeout=15.0,
        )

    status, resp = _send(access)
    # Refresh-once on 401 (stale access token).
    if status == 401:
        refreshed = _google_refresh_access_token()
        if refreshed:
            status, resp = _send(refreshed)

    if status == 200 and isinstance(resp, dict) and resp.get("id"):
        return True, {"message_id": resp["id"], "thread_id": resp.get("threadId")}
    # Normalise Google's error shape to something UI-friendly.
    err = resp.get("error") if isinstance(resp, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or f"HTTP {status}"
    else:
        msg = resp.get("error") if isinstance(resp, dict) else None
        msg = msg or f"HTTP {status}"
    return False, {"error": msg}


def _execute_calendar_create_event(action_data: dict) -> tuple[bool, dict]:
    """Create a single event on Adam's primary Google Calendar.

    Event body mirrors Google Calendar API v3: `start.dateTime` + `start.timeZone`
    (same for end). Optional description/location/attendees forwarded as-is.
    Refresh-once on 401 to match the Gmail executor's shape."""
    access = _kc_get("google-workspace", "access_token")
    if not access:
        access = _google_refresh_access_token()
    if not access:
        return False, {"error": "Google Workspace not connected — no access token."}

    tz = action_data.get("timezone") or "Europe/London"
    event: dict = {
        "summary": action_data["summary"],
        "start": {"dateTime": action_data["start"], "timeZone": tz},
        "end": {"dateTime": action_data["end"], "timeZone": tz},
    }
    if action_data.get("description"):
        event["description"] = action_data["description"]
    if action_data.get("location"):
        event["location"] = action_data["location"]
    if action_data.get("attendees"):
        event["attendees"] = [{"email": e} for e in action_data["attendees"]]

    body = json.dumps(event).encode("utf-8")

    def _post(tok: str) -> tuple[int, dict]:
        return _http_json(
            "POST",
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
            body=body,
            timeout=15.0,
        )

    status, resp = _post(access)
    if status == 401:
        refreshed = _google_refresh_access_token()
        if refreshed:
            status, resp = _post(refreshed)

    if status in (200, 201) and isinstance(resp, dict) and resp.get("id"):
        return True, {
            "event_id": resp["id"],
            "html_link": resp.get("htmlLink"),
            "summary": resp.get("summary") or action_data["summary"],
        }
    err = resp.get("error") if isinstance(resp, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or f"HTTP {status}"
    else:
        msg = resp.get("error") if isinstance(resp, dict) else None
        msg = msg or f"HTTP {status}"
    return False, {"error": msg}


def _execute_drive_create_doc(action_data: dict) -> tuple[bool, dict]:
    """Create a Google Doc (or plain text file) on Adam's Drive.

    Uses Drive v3 multipart upload — one request that carries both metadata
    and content. For a Google Doc target, the content part is sent as HTML
    so Drive's converter lays it out; for text/plain, the file stays raw.
    Refresh-once on 401 to match Gmail/Calendar shape."""
    access = _kc_get("google-workspace", "access_token")
    if not access:
        access = _google_refresh_access_token()
    if not access:
        return False, {"error": "Google Workspace not connected — no access token."}

    name = action_data["name"]
    content = action_data.get("content") or ""
    mime = action_data.get("mime_type") or "application/vnd.google-apps.document"

    metadata: dict = {"name": name, "mimeType": mime}
    if action_data.get("folder_id"):
        metadata["parents"] = [action_data["folder_id"]]

    boundary = "mission_control_boundary_" + uuid.uuid4().hex
    content_type = "text/plain; charset=UTF-8" if mime == "text/plain" else "text/html; charset=UTF-8"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {content_type}\r\n\r\n"
        f"{content}\r\n"
        f"--{boundary}--"
    ).encode("utf-8")

    def _post(tok: str) -> tuple[int, dict]:
        return _http_json(
            "POST",
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
            body=body,
            timeout=20.0,
        )

    status, resp = _post(access)
    if status == 401:
        refreshed = _google_refresh_access_token()
        if refreshed:
            status, resp = _post(refreshed)

    if status in (200, 201) and isinstance(resp, dict) and resp.get("id"):
        file_id = resp["id"]
        if mime == "application/vnd.google-apps.document":
            web_link = f"https://docs.google.com/document/d/{file_id}/edit"
        else:
            web_link = f"https://drive.google.com/file/d/{file_id}/view"
        return True, {
            "file_id": file_id,
            "web_link": web_link,
            "name": resp.get("name") or name,
            "mime_type": mime,
        }

    err = resp.get("error") if isinstance(resp, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or f"HTTP {status}"
    else:
        msg = (resp.get("error") if isinstance(resp, dict) else None) or f"HTTP {status}"
    return False, {"error": msg}


def _execute_contacts_create(action_data: dict) -> tuple[bool, dict]:
    """Create a Google Contact via People API v1.

    Splits the display name on the first space into given/family. Any missing
    optional field is simply not included in the payload."""
    access = _kc_get("google-workspace", "access_token")
    if not access:
        access = _google_refresh_access_token()
    if not access:
        return False, {"error": "Google Workspace not connected — no access token."}

    full_name = action_data["name"].strip()
    parts = full_name.split(" ", 1)
    given = parts[0]
    family = parts[1] if len(parts) > 1 else ""

    person: dict = {
        "names": [{
            "givenName": given,
            "familyName": family,
            "displayName": full_name,
        }]
    }
    if action_data.get("email"):
        person["emailAddresses"] = [{"value": action_data["email"]}]
    if action_data.get("phone"):
        person["phoneNumbers"] = [{"value": action_data["phone"]}]
    if action_data.get("company"):
        person["organizations"] = [{"name": action_data["company"]}]
    if action_data.get("notes"):
        person["biographies"] = [{
            "value": action_data["notes"],
            "contentType": "TEXT_PLAIN",
        }]

    body = json.dumps(person).encode("utf-8")

    def _post(tok: str) -> tuple[int, dict]:
        return _http_json(
            "POST",
            "https://people.googleapis.com/v1/people:createContact",
            headers={
                "Authorization": f"Bearer {tok}",
                "Content-Type": "application/json",
            },
            body=body,
            timeout=15.0,
        )

    status, resp = _post(access)
    if status == 401:
        refreshed = _google_refresh_access_token()
        if refreshed:
            status, resp = _post(refreshed)

    if status in (200, 201) and isinstance(resp, dict) and resp.get("resourceName"):
        return True, {
            "resource_name": resp["resourceName"],
            "name": full_name,
        }

    err = resp.get("error") if isinstance(resp, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or f"HTTP {status}"
    else:
        msg = (resp.get("error") if isinstance(resp, dict) else None) or f"HTTP {status}"
    return False, {"error": msg}


def _execute_ghl_create_contact(action_data: dict) -> tuple[bool, dict]:
    """Push a validated contact payload into GHL via the V2 client.

    The executor doesn't need access tokens — `ghl.create_contact` reads its
    credentials directly from Keychain, mirroring the Cognism / Lusha pattern.
    On success we surface the contact ID and a deep link Adam can open in
    the GHL UI (his white-labelled domain may differ; we use the canonical
    one and let GHL redirect)."""
    result = ghl.create_contact(action_data)
    if result.get("success"):
        contact_id = result.get("contact_id")
        view_link = (
            f"https://app.gohighlevel.com/v2/location/{_kc_get('ghl', 'location_id') or ''}/contacts/detail/{contact_id}"
            if contact_id else None
        )
        return True, {
            "contact_id": contact_id,
            "contact": result.get("contact"),
            "view_link": view_link,
        }
    return False, _failure(result, "GHL create_contact failed.")


def _ghl_view_link(contact_id: Optional[str]) -> Optional[str]:
    """Build a deep link into Adam's GHL UI for a contact."""
    location_id = _kc_get("ghl", "location_id") or ""
    if not contact_id or not location_id:
        return None
    return f"https://app.gohighlevel.com/v2/location/{location_id}/contacts/detail/{contact_id}"


def _failure(result: dict, fallback: str) -> dict:
    """Build a uniform executor failure dict. Forwards `needs_setup` and
    `needs_api_enable` from the integration client when present so
    /tools/execute can either pop SetupModal (credentials missing) or render
    an inline activation banner (API not enabled)."""
    out = {"error": result.get("error") or fallback}
    if result.get("needs_setup"):
        out["needs_setup"] = result["needs_setup"]
    if result.get("needs_api_enable"):
        out["needs_api_enable"] = result["needs_api_enable"]
    return out


def _execute_ghl_update_contact(action_data: dict) -> tuple[bool, dict]:
    contact_id = action_data["contact_id"]
    result = ghl.update_contact(contact_id, action_data["updates"])
    if result.get("success"):
        return True, {
            "contact_id": contact_id,
            "contact": result.get("contact"),
            "view_link": _ghl_view_link(contact_id),
        }
    return False, _failure(result, "GHL update_contact failed.")


def _execute_ghl_send_message(action_data: dict) -> tuple[bool, dict]:
    result = ghl.send_message(
        contact_id=action_data["contact_id"],
        message_type=action_data["message_type"],
        body=action_data["body"],
        subject=action_data.get("subject"),
    )
    if result.get("success"):
        return True, {
            "message_id": result.get("message_id"),
            "conversation_id": result.get("conversation_id"),
            "message_type": action_data["message_type"],
            "view_link": _ghl_view_link(action_data["contact_id"]),
        }
    return False, _failure(result, "GHL send_message failed.")


def _execute_ghl_add_note(action_data: dict) -> tuple[bool, dict]:
    result = ghl.add_note(action_data["contact_id"], action_data["body"])
    if result.get("success"):
        return True, {
            "note_id": result.get("note_id"),
            "note": result.get("note"),
            "contact_id": action_data["contact_id"],
            "view_link": _ghl_view_link(action_data["contact_id"]),
        }
    return False, _failure(result, "GHL add_note failed.")


# --- Google Workspace v2 executors -----------------------------------------
#
# Thin shells over the per-service modules. Failures forward `needs_setup`
# through `_failure` so the UI pops SetupModal on credential-missing errors.

def _execute_google_calendar_create_event(action_data: dict) -> tuple[bool, dict]:
    res = google_calendar.create_event(
        summary=action_data["summary"],
        start=action_data["start"],
        end=action_data["end"],
        timezone=action_data.get("timezone"),
        description=action_data.get("description"),
        location=action_data.get("location"),
        attendees=action_data.get("attendees"),
    )
    if res.get("success"):
        return True, {
            "event_id": res.get("event_id"),
            "html_link": res.get("html_link"),
            "summary": res.get("summary") or action_data.get("summary"),
        }
    return False, _failure(res, "Google Calendar create_event failed.")


def _execute_google_gmail_send(action_data: dict) -> tuple[bool, dict]:
    res = google_gmail.send_message(
        to=action_data["to"],
        subject=action_data["subject"],
        body=action_data["body"],
        cc=action_data.get("cc"),
        bcc=action_data.get("bcc"),
    )
    if res.get("success"):
        return True, {
            "message_id": res.get("message_id"),
            "thread_id": res.get("thread_id"),
        }
    return False, _failure(res, "Gmail send failed.")


def _execute_google_drive_create_file(action_data: dict) -> tuple[bool, dict]:
    """Drive file create routes through Docs for richer content support — v1
    treats every Drive create as "make a Google Doc with this name + body"
    so Adam doesn't have to think about MIME types in chat."""
    res = google_docs.create_doc(
        title=action_data["name"],
        content=action_data.get("content") or "",
    )
    if res.get("success"):
        return True, {
            "doc_id": res.get("doc_id"),
            "url": res.get("url"),
            "title": res.get("title") or action_data["name"],
            "warning": res.get("error"),  # set when content insert failed mid-create
        }
    return False, _failure(res, "Drive create_file failed.")


def _execute_google_sheets_append(action_data: dict) -> tuple[bool, dict]:
    res = google_sheets.append_rows(
        spreadsheet_id=action_data["spreadsheet_id"],
        range=action_data["range"],
        rows=action_data["rows"],
    )
    if res.get("success"):
        return True, {
            "spreadsheet_id": res.get("spreadsheet_id"),
            "updated_range": res.get("updated_range"),
            "updated_rows": res.get("updated_rows"),
            "url": f"https://docs.google.com/spreadsheets/d/{res.get('spreadsheet_id')}/edit",
        }
    return False, _failure(res, "Sheets append failed.")


def _execute_google_sheets_create(action_data: dict) -> tuple[bool, dict]:
    res = google_sheets.create_sheet(action_data["title"])
    if res.get("success"):
        return True, {
            "spreadsheet_id": res.get("spreadsheet_id"),
            "url": res.get("url"),
            "title": res.get("title"),
        }
    return False, _failure(res, "Sheets create failed.")


def _execute_google_docs_create(action_data: dict) -> tuple[bool, dict]:
    res = google_docs.create_doc(action_data["title"], content=action_data.get("content"))
    if res.get("success"):
        return True, {
            "doc_id": res.get("doc_id"),
            "url": res.get("url"),
            "title": res.get("title") or action_data["title"],
            "warning": res.get("error"),  # see google_docs.create_doc partial-success branch
        }
    return False, _failure(res, "Docs create failed.")


def _execute_google_docs_update(action_data: dict) -> tuple[bool, dict]:
    res = google_docs.update_doc(action_data["doc_id"], action_data["content"])
    if res.get("success"):
        return True, {
            "doc_id": res.get("doc_id"),
            "url": res.get("url"),
        }
    return False, _failure(res, "Docs update failed.")


_EXECUTORS = {
    "gmail.send": _execute_gmail_send,
    "calendar.create_event": _execute_calendar_create_event,
    "drive.create_doc": _execute_drive_create_doc,
    "contacts.create": _execute_contacts_create,
    "ghl.create_contact": _execute_ghl_create_contact,
    "ghl.update_contact": _execute_ghl_update_contact,
    "ghl.send_message": _execute_ghl_send_message,
    "ghl.add_note": _execute_ghl_add_note,
    "google.calendar_create_event": _execute_google_calendar_create_event,
    "google.gmail_send":             _execute_google_gmail_send,
    "google.drive_create_file":      _execute_google_drive_create_file,
    "google.sheets_append":          _execute_google_sheets_append,
    "google.sheets_create":          _execute_google_sheets_create,
    "google.docs_create":            _execute_google_docs_create,
    "google.docs_update":            _execute_google_docs_update,
}


# -- Models -----------------------------------------------------------------

class ExecutePayload(BaseModel):
    confirmation_token: str


# -- Endpoints --------------------------------------------------------------

def _row_to_pending(row: sqlite3.Row) -> dict:
    try:
        data = json.loads(row["action_data_json"])
    except (ValueError, TypeError):
        data = {}
    created = row["created_at"]
    # created_at is stored as naive UTC ISO ("YYYY-MM-DD HH:MM:SS").
    try:
        created_dt = datetime.fromisoformat(created.replace(" ", "T"))
        expires_dt = created_dt + timedelta(seconds=PENDING_ACTION_TTL_SECONDS)
        expires_at = expires_dt.isoformat(sep=" ", timespec="seconds")
    except (ValueError, AttributeError):
        expires_at = None
    return {
        "confirmation_token": row["id"],
        "conversation_id": row["conversation_id"],
        "action_type": row["action_type"],
        "action_data": data,
        "status": row["status"],
        "created_at": created,
        "executed_at": row["executed_at"],
        "expires_at": expires_at,
    }


@app.get("/tools/pending/{token}")
def tools_pending_get(token: str):
    conn = _db()
    row = conn.execute(
        "SELECT id, conversation_id, action_type, action_data_json, status, created_at, executed_at FROM pending_actions WHERE id = ?",
        (token,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="No pending action with that token.")
    return _row_to_pending(row)


@app.post("/tools/execute")
def tools_execute(payload: ExecutePayload):
    token = (payload.confirmation_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="confirmation_token is required.")
    conn = _db()
    cur = conn.cursor()
    _expire_old_pending_actions(cur)
    row = cur.execute(
        "SELECT id, conversation_id, action_type, action_data_json, status FROM pending_actions WHERE id = ?",
        (token,),
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="No pending action with that token.")
    if row["status"] != "pending":
        conn.close()
        raise HTTPException(status_code=409, detail=f"Action is {row['status']}, not pending.")

    executor = _EXECUTORS.get(row["action_type"])
    if not executor:
        conn.close()
        raise HTTPException(status_code=501, detail=f"No executor for '{row['action_type']}'.")

    try:
        data = json.loads(row["action_data_json"])
    except (ValueError, TypeError):
        data = {}

    success, result = executor(data)

    # Record to audit_log regardless of outcome.
    audit_id = str(uuid.uuid4())
    cur.execute(
        """
        INSERT INTO audit_log (id, action_type, action_data_json, result_json, success, user)
        VALUES (?, ?, ?, ?, ?, 'adam')
        """,
        (audit_id, row["action_type"], row["action_data_json"], json.dumps(result), 1 if success else 0),
    )

    if success:
        cur.execute(
            "UPDATE pending_actions SET status = 'executed', executed_at = CURRENT_TIMESTAMP WHERE id = ?",
            (token,),
        )
    # On failure we leave the row as 'pending' so Adam can retry from the same
    # card — audit_log captures the failed attempt.
    conn.commit()
    conn.close()

    response: dict = {
        "success": success,
        "result": result if success else None,
        "error": result.get("error") if not success else None,
        "audit_id": audit_id,
    }
    # `needs_setup` and `needs_api_enable` are mutually exclusive surfaces:
    # the first pops SetupModal (credentials missing); the second renders an
    # inline activation banner (API not enabled). Either may be present on
    # a non-success result; neither appears on success.
    if not success and isinstance(result, dict):
        if result.get("needs_setup"):
            response["needs_setup"] = result["needs_setup"]
        if result.get("needs_api_enable"):
            response["needs_api_enable"] = result["needs_api_enable"]
    return response


@app.post("/tools/cancel/{token}")
def tools_cancel(token: str):
    conn = _db()
    cur = conn.cursor()
    row = cur.execute("SELECT status FROM pending_actions WHERE id = ?", (token,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="No pending action with that token.")
    if row["status"] != "pending":
        conn.close()
        return {"cancelled": False, "status": row["status"]}
    cur.execute("UPDATE pending_actions SET status = 'cancelled' WHERE id = ?", (token,))
    conn.commit()
    conn.close()
    return {"cancelled": True}


@app.get("/tools/audit")
def tools_audit(limit: int = Query(50, ge=1, le=500)):
    conn = _db()
    rows = conn.execute(
        """
        SELECT id, timestamp, action_type, action_data_json, result_json, success, user
        FROM audit_log
        ORDER BY timestamp DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        try:
            data = json.loads(r["action_data_json"])
        except (ValueError, TypeError):
            data = {}
        try:
            result = json.loads(r["result_json"]) if r["result_json"] else None
        except (ValueError, TypeError):
            result = None
        out.append({
            "id": r["id"],
            "timestamp": r["timestamp"],
            "action_type": r["action_type"],
            "action_data": data,
            "result": result,
            "success": bool(r["success"]),
            "user": r["user"],
        })
    return {"audit": out}


# ---------------------------------------------------------------------------
# GoHighLevel — read-only convenience endpoints for the marketing UI / Jackson.
# ---------------------------------------------------------------------------
#
# These mirror the read-only methods on `integrations.ghl`. They never write
# to GHL — write paths must go through the action-card pattern so Adam stays
# in the loop. All four return the client's normalised shape verbatim, so the
# frontend can render directly without further parsing.

@app.get("/integrations/ghl/contacts")
def ghl_contacts(query: Optional[str] = Query(None), limit: int = Query(20, ge=1, le=100)):
    return ghl.list_contacts(query=query, limit=limit)


@app.get("/integrations/ghl/contacts/{contact_id}")
def ghl_contact(contact_id: str):
    return ghl.get_contact(contact_id)


@app.get("/integrations/ghl/opportunities")
def ghl_opportunities(pipeline_id: Optional[str] = Query(None), limit: int = Query(20, ge=1, le=100)):
    return ghl.list_opportunities(pipeline_id=pipeline_id, limit=limit)


@app.get("/integrations/ghl/conversations")
def ghl_conversations(contact_id: Optional[str] = Query(None), limit: int = Query(20, ge=1, le=100)):
    return ghl.list_conversations(contact_id=contact_id, limit=limit)


@app.get("/integrations/ghl/conversations/{conversation_id}/messages")
def ghl_conversation_messages(conversation_id: str):
    return ghl.get_conversation_messages(conversation_id)


@app.get("/integrations/ghl/calendars")
def ghl_calendars():
    return ghl.list_calendars()


@app.get("/integrations/ghl/calendars/{calendar_id}/events")
def ghl_calendar_events(
    calendar_id: str,
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
):
    return ghl.list_calendar_events(calendar_id, start=start, end=end)


# ---------------------------------------------------------------------------
# Onboarding — first-run gateway configuration.
# ---------------------------------------------------------------------------
#
# The packaged .app lands with no Anthropic key set; chat therefore fails at
# the OpenClaw gateway. Onboarding is the UI-driven replacement for Adam
# having to open Terminal and run `openclaw configure --section gateway`.
#
# Flow:
#   1. App boot → GET /onboarding/status
#   2. If needs_onboarding, UI shows the welcome screen.
#   3. Adam pastes his key → POST /onboarding/configure
#      - Store the key in the macOS Keychain (service "mission-control-ai",
#        account "anthropic:api_key").
#      - Merge the required fields into ~/.openclaw/openclaw.json atomically
#        (tempfile + os.replace). Existing unrelated fields are preserved.
#      - Set os.environ["ANTHROPIC_API_KEY"] so the live backend (and every
#        openclaw subprocess it spawns) picks up the new key instantly.
#      - Best-effort: kill any stale gateway on :18789 so the next /chat spins
#        up a fresh one against the new config.
#      - Verify by calling the Anthropic /v1/messages endpoint with
#        max_tokens=1.
#
# The key NEVER enters SQLite, logs, or any response body.

# Keychain coordinates for Adam's Anthropic key. Matches the _kc_* helpers'
# "{tool_id}:{field}" username convention so the key sits alongside the other
# integration credentials without a separate service name.
ONBOARDING_TOOL_ID = "anthropic"
ONBOARDING_FIELD = "api_key"
ONBOARDING_KEYCHAIN_ACCOUNT = f"{ONBOARDING_TOOL_ID}:{ONBOARDING_FIELD}"
ANTHROPIC_KEY_RE = re.compile(r"^sk-ant-[A-Za-z0-9_\-]{20,}$")
DEFAULT_FAST_MODEL = "anthropic/claude-sonnet-4-6"


def _read_openclaw_config() -> Optional[dict]:
    """Return parsed openclaw.json or None if missing/unreadable.

    Never raises — callers treat None as 'not configured' for the purposes of
    the onboarding check."""
    if not OPENCLAW_CONFIG_PATH.exists():
        return None
    try:
        return json.loads(OPENCLAW_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _detect_provider_from_config(cfg: Optional[dict]) -> Optional[str]:
    """Pull the configured provider prefix off agents.defaults.model.primary.
    Returns 'anthropic' | 'openai' | 'other' | None."""
    if not cfg:
        return None
    try:
        primary = cfg["agents"]["defaults"]["model"]["primary"]
    except (KeyError, TypeError):
        return None
    if not isinstance(primary, str) or "/" not in primary:
        return None
    prefix = primary.split("/", 1)[0].strip().lower()
    if prefix == "anthropic":
        return "anthropic"
    if prefix == "openai":
        return "openai"
    return "other" if prefix else None


def _has_gateway_config(cfg: Optional[dict]) -> bool:
    """Gateway is 'configured' if the section exists with a port + bind."""
    if not cfg:
        return False
    gw = cfg.get("gateway")
    if not isinstance(gw, dict):
        return False
    return bool(gw.get("port")) and bool(gw.get("bind"))


@app.get("/onboarding/status")
def onboarding_status():
    has_openclaw = os.path.exists(OPENCLAW_BIN)
    cfg = _read_openclaw_config()
    has_gateway = _has_gateway_config(cfg)
    provider = _detect_provider_from_config(cfg)
    has_key = bool(_kc_get(ONBOARDING_TOOL_ID, ONBOARDING_FIELD))

    needs = (
        not has_openclaw
        or not has_gateway
        or provider != "anthropic"
        or not has_key
    )
    return {
        "needs_onboarding": needs,
        "has_openclaw": has_openclaw,
        "has_gateway_config": has_gateway,
        "configured_provider": provider,
        "has_api_key": has_key,
    }


def _atomic_write_json(path: Path, data: dict) -> None:
    """Write JSON to `path` atomically (tempfile + os.replace, same dir).

    os.replace on macOS/Linux is atomic within a filesystem, so a crash halfway
    through leaves either the old content or the new — never a truncated blob."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
    try:
        tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def _merge_gateway_config(existing: Optional[dict]) -> dict:
    """Return a merged openclaw.json with the fields onboarding requires.

    Policy: preserve everything we don't explicitly own; overwrite only the
    gateway section scaffolding, the model primary, and the anthropic auth
    profile flag. OpenClaw's wizard/meta sections are left untouched.

    Note on the API key: OpenClaw resolves the Anthropic key via the standard
    ANTHROPIC_API_KEY env var (confirmed by the existing _invoke_openclaw path
    which propagates the backend env to the subprocess). We therefore do NOT
    embed the key inside openclaw.json — the key lives in the Keychain and is
    pushed into os.environ at backend startup and onboarding time. This keeps
    openclaw.json git/ops-safe (no secrets on disk)."""
    cfg: dict = dict(existing) if isinstance(existing, dict) else {}

    # agents.defaults.model.primary → anthropic/claude-sonnet-4-6 (fast brain).
    agents = cfg.get("agents") if isinstance(cfg.get("agents"), dict) else {}
    defaults = agents.get("defaults") if isinstance(agents.get("defaults"), dict) else {}
    model = defaults.get("model") if isinstance(defaults.get("model"), dict) else {}
    model["primary"] = DEFAULT_FAST_MODEL
    if "fallbacks" not in model or not isinstance(model["fallbacks"], list):
        model["fallbacks"] = []
    defaults["model"] = model
    agents["defaults"] = defaults
    cfg["agents"] = agents

    # gateway: local + loopback + token auth on :18789.
    gw = cfg.get("gateway") if isinstance(cfg.get("gateway"), dict) else {}
    gw["mode"] = gw.get("mode") or "local"
    gw["port"] = GATEWAY_PORT
    gw["bind"] = "loopback"
    auth = gw.get("auth") if isinstance(gw.get("auth"), dict) else {}
    auth["mode"] = "token"
    if not auth.get("token"):
        # Fresh install: mint a loopback-only token so OpenClaw's control UI
        # has something to authenticate internal calls with. Hex-encoded, 48
        # bytes = 96 hex chars; plenty of entropy.
        import secrets as _secrets
        auth["token"] = _secrets.token_hex(24)
    gw["auth"] = auth
    cfg["gateway"] = gw

    # auth.profiles.anthropic:default — declare we use api_key auth for
    # Anthropic. Resolution happens via ANTHROPIC_API_KEY env var at runtime.
    root_auth = cfg.get("auth") if isinstance(cfg.get("auth"), dict) else {}
    profiles = root_auth.get("profiles") if isinstance(root_auth.get("profiles"), dict) else {}
    anth = profiles.get("anthropic:default") if isinstance(profiles.get("anthropic:default"), dict) else {}
    anth["provider"] = "anthropic"
    anth["mode"] = "api_key"
    profiles["anthropic:default"] = anth
    root_auth["profiles"] = profiles
    cfg["auth"] = root_auth

    return cfg


def _kill_gateway_on_port(port: int) -> None:
    """Best-effort: kill any python/node process holding `port` so the next
    chat call gets a fresh gateway that reloads the new config. Swallow all
    failures — if nothing is listening, lsof exits 1 and we move on."""
    try:
        pids_raw = subprocess.check_output(
            ["/usr/sbin/lsof", f"-tiTCP:{port}", "-sTCP:LISTEN"],
            stderr=subprocess.DEVNULL,
        ).decode("utf-8").strip()
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return
    for pid_str in pids_raw.split("\n"):
        try:
            pid = int(pid_str.strip())
        except ValueError:
            continue
        try:
            cmd = subprocess.check_output(
                ["/bin/ps", "-p", str(pid), "-o", "command="],
                stderr=subprocess.DEVNULL,
            ).decode("utf-8").strip()
        except (subprocess.CalledProcessError, OSError):
            continue
        # Only kill things we recognise as gateway-ish — never hit an
        # unrelated process that happens to be holding the port.
        if re.search(r"openclaw|node|python|uvicorn", cmd, re.IGNORECASE):
            try:
                os.kill(pid, 15)  # SIGTERM
            except (ProcessLookupError, PermissionError, OSError):
                pass


def _verify_anthropic_key(api_key: str) -> tuple[bool, Optional[str]]:
    """Call /v1/messages with max_tokens=1 to confirm the key is live.

    Success: HTTP 200 with a message body. Any non-200 returns (False, <msg>).
    Network failures also return (False, <msg>) so the UI can show something
    useful rather than hanging."""
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
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
        with urllib.request.urlopen(req, timeout=8.0) as resp:
            if resp.status == 200:
                return True, None
            return False, f"Anthropic returned HTTP {resp.status}."
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
            msg = payload.get("error", {}).get("message") if isinstance(payload.get("error"), dict) else None
        except (ValueError, OSError):
            msg = None
        if e.code == 401:
            return False, "Anthropic rejected the key (401). Double-check it at console.anthropic.com."
        if e.code == 403:
            return False, "Key is valid but lacks permission (403). Check billing + org access."
        return False, msg or f"Anthropic returned HTTP {e.code}."
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return False, f"Couldn't reach Anthropic: {e}"


class OnboardingPayload(BaseModel):
    anthropic_api_key: str


@app.post("/onboarding/configure")
def onboarding_configure(payload: OnboardingPayload):
    key = (payload.anthropic_api_key or "").strip()
    # Defensive: reject empty, malformed, or obviously-fake keys client-side
    # bypasses are common when someone hits the endpoint directly.
    if not key:
        raise HTTPException(status_code=400, detail="Missing anthropic_api_key.")
    if not ANTHROPIC_KEY_RE.match(key):
        raise HTTPException(
            status_code=400,
            detail="That doesn't look like an Anthropic key. They start with 'sk-ant-' and are at least 20 characters.",
        )

    # 1) Verify the key against Anthropic BEFORE touching disk. If it's dud,
    #    we don't want to have already rewritten openclaw.json and bounced
    #    the gateway.
    ok, err = _verify_anthropic_key(key)
    if not ok:
        return {"success": False, "error": err or "Key did not verify."}

    # 2) Store in Keychain. From this point the key exists in the system
    #    credential store and os.environ — every subsequent openclaw
    #    subprocess picks it up.
    try:
        _kc_set(ONBOARDING_TOOL_ID, ONBOARDING_FIELD, key)
    except keyring.errors.KeyringError as e:
        return {"success": False, "error": f"Could not save to Keychain: {e}"}
    os.environ["ANTHROPIC_API_KEY"] = key

    # 3) Merge + write openclaw.json atomically.
    try:
        existing = _read_openclaw_config()
        merged = _merge_gateway_config(existing)
        _atomic_write_json(OPENCLAW_CONFIG_PATH, merged)
    except OSError as e:
        # Key is in Keychain but config write failed — surface the error but
        # don't roll back the key (user can hit Reconfigure to retry).
        return {"success": False, "error": f"Wrote key to Keychain, but config file write failed: {e}"}

    # 4) Best-effort: kick the old gateway so the next /chat starts fresh.
    _kill_gateway_on_port(GATEWAY_PORT)

    return {"success": True}


# ---------------------------------------------------------------------------
# MAN identification workflow
# ---------------------------------------------------------------------------
#
# Four endpoints the UI calls to run JSP's Money/Authority/Need flow:
#   GET  /workflow/man/status              — readiness check (all 3 creds set?)
#   POST /workflow/man/process-lead        — single company → MAN + contact
#   POST /workflow/man/process-batch       — up to 200 companies at once
#   POST /workflow/man/upload-spreadsheet  — CSV → parsed lead rows (preview)
#
# All mutating endpoints write a row to audit_log for traceability.


def _audit_log_write(
    action_type: str,
    action_data: dict,
    result: dict,
    success: bool,
) -> str:
    """Write a single audit_log row. Mirrors the inline INSERT in /tools/execute."""
    conn = _db()
    cur = conn.cursor()
    audit_id = str(uuid.uuid4())
    cur.execute(
        "INSERT INTO audit_log (id, action_type, action_data_json, result_json, success, user) "
        "VALUES (?, ?, ?, ?, ?, 'adam')",
        (
            audit_id,
            action_type,
            json.dumps(action_data, default=str),
            json.dumps(result, default=str),
            1 if success else 0,
        ),
    )
    conn.commit()
    conn.close()
    return audit_id


def _first_present(keys: list[str], candidates: list[str]) -> Optional[str]:
    """Pick the first candidate header that appears in `keys` (case-insensitive)."""
    if not keys:
        return None
    direct = {k: k for k in keys}
    for c in candidates:
        if c in direct:
            return direct[c]
    lower = {k.strip().lower(): k for k in keys}
    for c in candidates:
        if c.strip().lower() in lower:
            return lower[c.strip().lower()]
    return None


# Zint's export and older 3-column formats both parse through this synonyms table.
# Adding a synonym here automatically wires it into _detect_zint_columns below.
_ZINT_COLUMN_SYNONYMS = {
    "name":              ["company name", "company_name", "company", "name"],
    "number":            ["company number", "company_number", "crn", "companies house number"],
    "domain":            ["domain", "website", "url"],
    "first_name":        ["first name", "first_name", "firstname"],
    "last_name":         ["last name", "last_name", "lastname", "surname"],
    "job_title":         ["job title", "job_title", "title", "role"],
    "linkedin":          ["linkedin", "linkedin url", "linkedin_url"],
    "email":             ["email", "email address", "e-mail"],
    "mobile":            ["whatsapp mobile number", "mobile", "phone", "phone number", "mobile number"],
    "revenue":           ["revenue", "annual revenue"],
    "industry":          ["primary industry", "industry"],
    "hubspot_crm":       ["hubspot crm", "hubspot_crm", "crm"],
    "pipeline_priority": ["pipeline priority", "pipeline_priority", "priority"],
    "headcount":         ["headcount", "employees"],
    "ubo":               ["ultimate beneficial owners", "ubo", "beneficial owners"],
}


def _detect_zint_columns(header: list[str]) -> dict:
    """Map schema keys -> the actual header string from the CSV (or None)."""
    mapping: dict[str, Optional[str]] = {}
    for schema_key, candidates in _ZINT_COLUMN_SYNONYMS.items():
        mapping[schema_key] = _first_present(header, candidates)
    return mapping


@app.get("/workflow/man/status")
def man_status():
    pomanda_ok = bool(_kc_get("pomanda", "api_key"))
    cognism_ok = bool(_kc_get("cognism", "api_key"))
    lusha_ok = bool(_kc_get("lusha", "api_key"))
    # GHL is *not* required for the MAN workflow itself — it's a downstream
    # destination for verified contacts. Surfaced here so the UI can show a
    # "push to GHL" affordance once the workflow finishes.
    ghl_ok = bool(_kc_get("ghl", "api_key") and _kc_get("ghl", "location_id"))
    missing = [
        tid for tid, ok in (
            ("pomanda", pomanda_ok),
            ("cognism", cognism_ok),
            ("lusha", lusha_ok),
        ) if not ok
    ]
    return {
        "ready": not missing,
        "pomanda_configured": pomanda_ok,
        "cognism_configured": cognism_ok,
        "lusha_configured": lusha_ok,
        "ghl_configured": ghl_ok,
        "missing": missing,
    }


@app.post("/workflow/man/process-lead")
def man_process_lead(payload: ManLeadPayload):
    company = payload.dict(exclude_none=True)
    result = man_workflow.process_lead(company)
    _audit_log_write(
        "man_process_lead",
        company,
        result,
        success=(result.get("status") == "success"),
    )
    return result


@app.post("/workflow/man/process-batch")
def man_process_batch(payload: ManBatchPayload):
    leads = [l.dict(exclude_none=True) for l in payload.leads]
    result = man_workflow.process_batch(leads, max_leads=payload.max or 200)
    _audit_log_write(
        "man_process_batch",
        {"count": len(leads), "max": payload.max or 200},
        {
            "total": result.get("total"),
            "truncated": result.get("truncated"),
            "summary": result.get("summary"),
            "credits_used": result.get("credits_used"),
        },
        success=True,
    )
    return result


@app.post("/workflow/man/upload-spreadsheet")
def man_upload_spreadsheet(payload: ManSpreadsheetPayload):
    """Parse a client-provided CSV string. The UI does the file read with
    FileReader.readAsText() and posts the raw text here — sidestepping the
    python-multipart dependency that FastAPI's UploadFile requires."""
    filename = (payload.filename or "").lower()
    if filename.endswith(".xlsx") or filename.endswith(".xls"):
        raise HTTPException(
            status_code=400,
            detail="Excel upload is not supported in v1 — please export as CSV.",
        )
    text = payload.csv_content or ""
    # Tolerate a UTF-8 BOM the frontend's FileReader may preserve.
    if text.startswith("﻿"):
        text = text.lstrip("﻿")
    if not text.strip():
        raise HTTPException(status_code=400, detail="CSV content is empty.")

    reader = csv.DictReader(io.StringIO(text))
    header = list(reader.fieldnames or [])
    col_map = _detect_zint_columns(header)
    mapped_headers = {v for v in col_map.values() if v}
    extra_columns = [h for h in header if h not in mapped_headers]

    if not col_map.get("name"):
        raise HTTPException(
            status_code=400,
            detail=(
                "CSV must contain a 'Company Name' column (or 'company', 'company_name', 'name'). "
                f"Columns found: {', '.join(header) or '(none)'}"
            ),
        )

    # Warn (not block) when there's no candidate MAN info in the file — the
    # workflow will fall through to Pomanda-based identification, which is fine
    # for older 3-column batches (name, number, website) as long as Pomanda is
    # configured. Surfaced as a warning in the response for the UI.
    has_candidate = bool(col_map.get("email") or (col_map.get("first_name") and col_map.get("last_name")))

    leads: list[dict] = []
    for row in reader:
        # Normalise: strip every value, collapse empty→None, preserve the full original row.
        clean_row = {(k or "").strip(): (v or "").strip() for k, v in row.items() if k is not None}
        name = clean_row.get(col_map["name"], "") if col_map.get("name") else ""
        if not name:
            continue

        def pick(key: str) -> Optional[str]:
            h = col_map.get(key)
            if not h:
                return None
            v = clean_row.get(h, "")
            return v or None

        leads.append({
            "name": name,
            "number": pick("number"),
            "domain": pick("domain"),
            "website": pick("domain"),  # back-compat alias
            "first_name": pick("first_name"),
            "last_name": pick("last_name"),
            "job_title": pick("job_title"),
            "linkedin": pick("linkedin"),
            "email": pick("email"),
            "mobile": pick("mobile"),
            "revenue": pick("revenue"),
            "industry": pick("industry"),
            "hubspot_crm": pick("hubspot_crm"),
            "pipeline_priority": pick("pipeline_priority"),
            "headcount": pick("headcount"),
            "ubo": pick("ubo"),
            "original_row": clean_row,
        })

    return {
        "leads": leads,
        "detected_columns": header,
        "column_mapping": {k: v for k, v in col_map.items() if v},
        "extra_columns": extra_columns,
        "count": len(leads),
        "has_zint_candidate": has_candidate,
    }


# ---------------------------------------------------------------------------
# Custom agents — CRUD over ~/.openclaw/workspace/agents/<slug>/.
# ---------------------------------------------------------------------------
#
# Built-in agents (personal, marketing, setup) are scaffolded by the workspace
# template installer and are read-only here — you can list them but you can't
# edit, delete, or recreate them through this surface.
#
# Custom agents live alongside the built-ins under the same agents/ folder.
# Each has:
#   SOUL.md          — generated from Adam's free-text answers (persona +
#                      capabilities + tools + model).
#   AGENTS.md        — short descriptor that the routing layer can read.
#   config.json      — model preference, tool whitelist, created_at, schema_v.
#   skills/          — empty directory; reserved for future per-agent skills.
#
# Slug rules: lowercased, words separated by `-`, no leading dot, no path
# separators. The reserved set blocks built-ins so a custom create can't
# overwrite them. Slugs round-trip 1:1 through filesystem and HTTP paths.

AGENT_BUILTIN_SLUGS = {"personal", "marketing", "setup"}
AGENT_BUILTIN_META = {
    "personal":  {"name": "Personal assistant",  "description": "Calendar, inbox, briefings, meeting prep, notes."},
    "marketing": {"name": "Marketing assistant", "description": "Leads, MAN identification, enrichment, pipeline."},
    "setup":     {"name": "Setup specialist",    "description": "Tool integrations and credential walk-throughs."},
}

# Wider model catalogue — Anthropic releases regularly, so the dict is the
# single place that knows the gateway-prefixed name and the friendly label.
# Keys are persisted in config.json; renames here don't break existing agents
# as long as the key stays stable.
AGENT_MODEL_CATALOGUE = {
    "sonnet-4-6": {"label": "Sonnet 4.6 — fast and balanced",      "anthropic": "anthropic/claude-sonnet-4-6"},
    "opus-4-7":   {"label": "Opus 4.7 — deepest thinking, slower", "anthropic": "anthropic/claude-opus-4-7"},
    "haiku-4-5":  {"label": "Haiku 4.5 — fastest and cheapest",    "anthropic": "anthropic/claude-haiku-4-5"},
}
AGENT_DEFAULT_MODEL = "sonnet-4-6"

# Tool catalogue surfaced through GET /agents/tools. UI checkboxes read from
# this so the descriptions stay in lockstep with what the backend actually
# wires up. Adding a future tool here doesn't auto-grant access — the agent's
# config.json captures Adam's selection at create-time.
AGENT_TOOL_CATALOGUE = {
    "google_workspace": "Calendar, Docs, Sheets, Drive, and Email",
    "hubspot":          "CRM contacts, deals, and companies",
    "ghl":              "GoHighLevel marketing CRM (contacts, conversations, opportunities)",
    "pomanda":          "UK Companies House data and shareholder lookup",
    "cognism":          "Email and mobile enrichment (primary)",
    "lusha":            "Email and mobile enrichment (fallback)",
}

AGENT_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _\-]{1,49}$")
AGENT_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,49}$")


def _slugify_agent_name(name: str) -> str:
    """Best-effort, deterministic slug from a free-text agent name.

    Lowercases, replaces runs of non-alphanumerics with `-`, trims leading
    and trailing dashes, and caps at 50 chars. Returns "" for unusable input
    so the caller can reject with a clear 400."""
    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = s.strip("-")
    return s[:50]


def _agent_dir(slug: str) -> Path:
    """Resolve a custom agent's workspace directory and refuse to escape.

    Without this guard, `slug = "../../etc"` would resolve to outside the
    workspace and we'd happily delete arbitrary files in DELETE /agents/<slug>.
    The slug regex already rejects `..` and `/`, but we double-check via
    Path.relative_to so even a future regex bug can't turn into RCE."""
    base = (WORKSPACE / "agents" / slug).resolve()
    try:
        base.relative_to(WORKSPACE.resolve())
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Invalid agent slug.") from e
    return base


def _build_agent_soul(
    name: str,
    soul_text: str,
    skills: list[str],
    tools: list[str],
    model_key: str,
) -> str:
    """Render the SOUL.md a custom agent ships with.

    Format mirrors the built-in agents at a high level (Identity / Capabilities
    / Tools / Model / Conversational style) so the main router agent can read
    them with the same heuristics."""
    skills = [s for s in (skills or []) if isinstance(s, str) and s.strip()]
    tools = [t for t in (tools or []) if t in AGENT_TOOL_CATALOGUE]
    skill_block = "\n".join(f"- {s.strip()}" for s in skills) if skills else "_None specified yet._"
    tool_block = (
        "\n".join(f"- **{tid}** — {AGENT_TOOL_CATALOGUE[tid]}" for tid in tools)
        if tools
        else "_No external tools selected._"
    )
    model_label = AGENT_MODEL_CATALOGUE.get(model_key, {}).get("label") or model_key
    return (
        f"# {name}\n\n"
        f"## Identity\n\n{soul_text.strip() or 'Custom agent.'}\n\n"
        f"## Capabilities\n\n{skill_block}\n\n"
        f"## Available tools\n\n{tool_block}\n\n"
        f"## Model\n\nThis agent uses **{model_label}** for responses.\n\n"
        "## Conversational style\n\n"
        "- Address the user as Adam.\n"
        "- Maintain the personality described above.\n"
        "- When unsure, ask Adam rather than guessing.\n"
        "- For tool actions, follow the golden rule: confirmation card before any external write.\n"
    )


def _build_agent_summary(name: str, skills: list[str], tools: list[str]) -> str:
    """Render the slim AGENTS.md companion file. Intentionally short — it
    exists so the main routing agent can scan a one-paragraph summary instead
    of loading the full SOUL.md on every turn."""
    skill_line = ", ".join(s.strip() for s in (skills or []) if isinstance(s, str) and s.strip()) or "(no skills declared)"
    tool_line = ", ".join(t for t in (tools or []) if t in AGENT_TOOL_CATALOGUE) or "(no tools)"
    return (
        f"# {name}\n\n"
        f"Custom agent created via Mission Control's Agents page.\n\n"
        f"**Skills:** {skill_line}\n\n"
        f"**Tools:** {tool_line}\n\n"
        "See `SOUL.md` for the full persona and `config.json` for model selection.\n"
    )


def _read_agent(slug: str) -> Optional[dict]:
    """Reads a custom agent's persisted state. Returns None when missing or
    when config.json can't be parsed — callers translate to 404."""
    d = _agent_dir(slug)
    cfg_path = d / "config.json"
    soul_path = d / "SOUL.md"
    if not cfg_path.exists() or not soul_path.exists():
        return None
    try:
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    try:
        soul = soul_path.read_text(encoding="utf-8")
    except OSError:
        soul = ""
    return {
        "slug": slug,
        "name": cfg.get("name") or slug,
        "soul": cfg.get("soul") or "",
        "soul_md": soul,
        "skills": cfg.get("skills") or [],
        "tools": cfg.get("tools") or [],
        "model": cfg.get("model") or AGENT_DEFAULT_MODEL,
        "created_at": cfg.get("created_at"),
        "updated_at": cfg.get("updated_at"),
    }


def _is_custom_agent_slug(slug: str) -> bool:
    """Cheap path check used by /chat to decide whether to load a custom
    agent's SOUL.md as a system-prompt preamble. Doesn't validate config.json
    contents — the chat path tolerates a missing file by falling back to the
    plain prefix routing."""
    if slug in AGENT_BUILTIN_SLUGS or slug in ("personal", "marketing", "setup"):
        return False
    if not AGENT_SLUG_RE.match(slug or ""):
        return False
    cfg = (WORKSPACE / "agents" / slug / "config.json")
    return cfg.exists()


class AgentCreatePayload(BaseModel):
    name: str
    soul: Optional[str] = ""
    skills: Optional[list[str]] = None
    tools: Optional[list[str]] = None
    model: Optional[str] = AGENT_DEFAULT_MODEL


class AgentUpdatePayload(BaseModel):
    name: Optional[str] = None
    soul: Optional[str] = None
    skills: Optional[list[str]] = None
    tools: Optional[list[str]] = None
    model: Optional[str] = None


@app.get("/agents/tools")
def agents_tool_catalogue():
    """Stable list of tool keys + friendly descriptions for the UI picker."""
    return {"tools": [{"id": k, "description": v} for k, v in AGENT_TOOL_CATALOGUE.items()]}


@app.get("/agents/models")
def agents_model_catalogue():
    """Stable list of model keys + friendly labels for the UI dropdown."""
    return {
        "default": AGENT_DEFAULT_MODEL,
        "models": [{"id": k, "label": v["label"]} for k, v in AGENT_MODEL_CATALOGUE.items()],
    }


@app.get("/agents/list")
def agents_list():
    """Enumerate built-in + custom agents.

    Built-ins come from a fixed dict; custom ones come from scanning
    workspace/agents/* for directories that aren't in AGENT_BUILTIN_SLUGS and
    have a config.json. Anything else (e.g. hand-edited specialist folders)
    is ignored — keeps the list grounded to what was created via this UI."""
    builtin = []
    for slug, meta in AGENT_BUILTIN_META.items():
        soul_path = WORKSPACE / "agents" / slug / "SOUL.md"
        builtin.append({
            "slug": slug,
            "name": meta["name"],
            "description": meta["description"],
            "exists": soul_path.exists(),
            "builtin": True,
        })

    custom: list[dict] = []
    agents_root = WORKSPACE / "agents"
    if agents_root.exists():
        for entry in sorted(agents_root.iterdir()):
            if not entry.is_dir():
                continue
            slug = entry.name
            if slug in AGENT_BUILTIN_SLUGS:
                continue
            data = _read_agent(slug)
            if not data:
                continue
            data["builtin"] = False
            data.pop("soul_md", None)  # keep list payload small; full SOUL.md loaded on detail
            custom.append(data)

    return {"builtin": builtin, "custom": custom}


@app.get("/agents/{slug}")
def agents_get(slug: str):
    if not AGENT_SLUG_RE.match(slug or ""):
        raise HTTPException(status_code=400, detail="Invalid slug.")
    if slug in AGENT_BUILTIN_SLUGS:
        meta = AGENT_BUILTIN_META[slug]
        soul_path = WORKSPACE / "agents" / slug / "SOUL.md"
        soul_md = soul_path.read_text(encoding="utf-8") if soul_path.exists() else ""
        return {
            "slug": slug,
            "name": meta["name"],
            "description": meta["description"],
            "soul_md": soul_md,
            "builtin": True,
        }
    data = _read_agent(slug)
    if not data:
        raise HTTPException(status_code=404, detail="Agent not found.")
    data["builtin"] = False
    return data


@app.post("/agents/create")
def agents_create(payload: AgentCreatePayload):
    """Create a new custom agent. Idempotency is intentional — duplicate names
    return 409 rather than silently overwriting an existing config.json (which
    would lose Adam's prior soul / skills / model selection)."""
    name = (payload.name or "").strip()
    if not name or not AGENT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Name must be 2–50 alphanumerics, spaces, hyphens, or underscores.")
    slug = _slugify_agent_name(name)
    if not slug or not AGENT_SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Could not derive a valid slug from that name.")
    if slug in AGENT_BUILTIN_SLUGS:
        raise HTTPException(status_code=409, detail=f"'{slug}' is a built-in agent.")

    model = payload.model or AGENT_DEFAULT_MODEL
    if model not in AGENT_MODEL_CATALOGUE:
        raise HTTPException(status_code=400, detail=f"Unknown model '{model}'.")

    tools = [t for t in (payload.tools or []) if t in AGENT_TOOL_CATALOGUE]

    skills_raw = payload.skills or []
    if isinstance(skills_raw, str):
        # Frontend may send skills as a single newline/comma blob — normalise
        # both shapes to a list of trimmed non-empty entries.
        skills_raw = re.split(r"[\n,]+", skills_raw)
    skills = [s.strip() for s in skills_raw if isinstance(s, str) and s.strip()]

    soul_text = (payload.soul or "").strip()

    d = _agent_dir(slug)
    if d.exists():
        raise HTTPException(status_code=409, detail=f"Agent '{slug}' already exists.")

    d.mkdir(parents=True, exist_ok=False)
    (d / "skills").mkdir(parents=True, exist_ok=True)

    now_iso = datetime.utcnow().isoformat(sep=" ", timespec="seconds")
    cfg = {
        "schema_v": 1,
        "slug": slug,
        "name": name,
        "soul": soul_text,
        "skills": skills,
        "tools": tools,
        "model": model,
        "created_at": now_iso,
        "updated_at": now_iso,
    }

    (d / "config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    (d / "SOUL.md").write_text(_build_agent_soul(name, soul_text, skills, tools, model), encoding="utf-8")
    (d / "AGENTS.md").write_text(_build_agent_summary(name, skills, tools), encoding="utf-8")

    return {"success": True, "slug": slug, "agent": _read_agent(slug)}


@app.put("/agents/{slug}")
def agents_update(slug: str, payload: AgentUpdatePayload):
    if not AGENT_SLUG_RE.match(slug or ""):
        raise HTTPException(status_code=400, detail="Invalid slug.")
    if slug in AGENT_BUILTIN_SLUGS:
        raise HTTPException(status_code=403, detail="Cannot edit built-in agents.")
    existing = _read_agent(slug)
    if not existing:
        raise HTTPException(status_code=404, detail="Agent not found.")

    name = (payload.name or existing["name"]).strip()
    if not AGENT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid name.")

    model = payload.model or existing["model"]
    if model not in AGENT_MODEL_CATALOGUE:
        raise HTTPException(status_code=400, detail=f"Unknown model '{model}'.")

    tools_in = payload.tools if payload.tools is not None else existing["tools"]
    tools = [t for t in (tools_in or []) if t in AGENT_TOOL_CATALOGUE]

    skills_in = payload.skills if payload.skills is not None else existing["skills"]
    if isinstance(skills_in, str):
        skills_in = re.split(r"[\n,]+", skills_in)
    skills = [s.strip() for s in (skills_in or []) if isinstance(s, str) and s.strip()]

    soul_text = (payload.soul if payload.soul is not None else existing["soul"]).strip()

    now_iso = datetime.utcnow().isoformat(sep=" ", timespec="seconds")
    cfg = {
        "schema_v": 1,
        "slug": slug,
        "name": name,
        "soul": soul_text,
        "skills": skills,
        "tools": tools,
        "model": model,
        "created_at": existing.get("created_at") or now_iso,
        "updated_at": now_iso,
    }

    d = _agent_dir(slug)
    (d / "config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    (d / "SOUL.md").write_text(_build_agent_soul(name, soul_text, skills, tools, model), encoding="utf-8")
    (d / "AGENTS.md").write_text(_build_agent_summary(name, skills, tools), encoding="utf-8")

    return {"success": True, "slug": slug, "agent": _read_agent(slug)}


@app.delete("/agents/{slug}")
def agents_delete(slug: str):
    if not AGENT_SLUG_RE.match(slug or ""):
        raise HTTPException(status_code=400, detail="Invalid slug.")
    if slug in AGENT_BUILTIN_SLUGS:
        raise HTTPException(status_code=403, detail="Cannot delete built-in agents.")
    d = _agent_dir(slug)
    if not d.exists():
        raise HTTPException(status_code=404, detail="Agent not found.")
    # shutil.rmtree is fine here — _agent_dir already verified the path lives
    # inside WORKSPACE so we can't walk out via a malicious slug.
    import shutil
    shutil.rmtree(d)
    return {"success": True, "slug": slug}
