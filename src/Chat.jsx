import React, { useState, useEffect, useRef } from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';
import { renderMarkdown } from './markdown.jsx';
import ActionCard, { splitByActionCards } from './ActionCard.jsx';
import EnrichmentProgressCard, { ENRICHMENT_PROGRESS_MARKER_RE } from './EnrichmentProgressCard.jsx';
import SetupModal from './SetupModal.jsx';

const API_BASE = "http://127.0.0.1:8001";

// Walk a text-split piece and further split it by enrichment-progress
// markers. Lets the message renderer interleave action cards, enrichment
// progress cards, and markdown text in any order.
function splitTextByEnrichmentMarkers(text) {
  if (!text) return [];
  const re = new RegExp(ENRICHMENT_PROGRESS_MARKER_RE.source, "g");
  const out = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "enrichment", jobId: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

function splitMessageBody(text) {
  // First split by [[action-card:...]], then walk text pieces and split
  // by [[enrichment-progress:...]] so both markers can appear in the
  // same reply.
  const pieces = splitByActionCards(text);
  const out = [];
  for (const p of pieces) {
    if (p.kind === "text") {
      out.push(...splitTextByEnrichmentMarkers(p.text));
    } else {
      out.push(p);
    }
  }
  return out;
}

// Summarise a batch result into a Marketing-agent reply body (markdown).
function _summaryText(batch, card) {
  if (!batch?.results) return "Finished, but the backend returned an unexpected response.";
  const counts = { verified: 0, upgraded: 0, enriched: 0, as_is: 0, partial: 0, error: 0, needs_review: 0 };
  for (const r of batch.results) {
    if (r.status === "error") counts.error++;
    else if (r.status === "needs_review") counts.needs_review++;
    else if (r.status === "partial") counts.partial++;
    else if (r.enrichment_status === "man_upgraded") counts.upgraded++;
    else if (r.enrichment_status === "man_from_zint_unverified" && r.contact_status === "contact_from_zint") counts.as_is++;
    else if (r.contact_status === "contact_enriched_cognism" || r.contact_status === "contact_enriched_lusha") counts.enriched++;
    else if (r.enrichment_status === "man_verified") counts.verified++;
    else counts.verified++;  // default bucket for status === success
  }
  const cu = batch.credits_used || {};
  const total = batch.total || 0;
  const filename = card?.filename || "your batch";
  const lines = [
    `Done. Processed **${total} lead${total === 1 ? "" : "s"}** from ${filename}:`,
    "",
    counts.verified ? `✓ ${counts.verified} verified (MAN confirmed, contact from Zint)` : null,
    counts.upgraded ? `⬆ ${counts.upgraded} MAN upgraded via Pomanda` : null,
    counts.enriched ? `⚡ ${counts.enriched} enriched (contact filled by Cognism/Lusha)` : null,
    counts.as_is ? `📋 ${counts.as_is} as-is (Pomanda not configured — Zint data unverified)` : null,
    counts.partial ? `⚠ ${counts.partial} partial (MAN found but contact incomplete)` : null,
    counts.needs_review ? `↗ ${counts.needs_review} needs manual review (parent-company case)` : null,
    counts.error ? `✗ ${counts.error} errors` : null,
    "",
    `Credits used: Cognism ${cu.cognism || 0} · Lusha ${cu.lusha || 0}`,
    "",
    "Use the **Download CSV** button on the card above to export everything with the original Zint columns preserved.",
  ].filter((l) => l !== null);
  return lines.join("\n");
}

function BrainPill({ model }) {
  if (model !== "sonnet" && model !== "opus") return null;
  const fast = model === "sonnet";
  const IconCmp = fast ? Icon.Zap : Icon.Brain;
  return (
    <div
      className="flex items-center gap-1 mt-1.5"
      style={{ fontSize: 11, color: "var(--fg-faint)" }}
    >
      {IconCmp ? <IconCmp className="lucide-xs" /> : null}
      <span>{fast ? "Quick reply" : "Thought deeply"}</span>
    </div>
  );
}

// Inline banner shown when a Google service request returned 403 with
// reason=SERVICE_DISABLED (i.e. OAuth is fine, the specific API just isn't
// enabled in Cloud Console). Distinct from the SetupModal flow — Adam needs
// a one-click jump to Google's activation page, not the credential wizard.
function ApiEnableBanner({ info }) {
  if (!info || !info.console_url) return null;
  const label = info.service_label || "Google API";
  const open = () => {
    try { window.open(info.console_url, "mc-google-enable", "noopener,noreferrer"); } catch { /* ignore */ }
  };
  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        background: "rgba(180, 67, 44, 0.06)",
        border: "1px solid rgba(180, 67, 44, 0.35)",
        borderRadius: 8,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <Icon.AlertTriangle className="lucide-sm" style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "var(--fg)", fontWeight: 500, marginBottom: 4 }}>
          {label} isn't enabled in your Google Cloud project
        </div>
        <div style={{ color: "var(--fg-muted)", marginBottom: 8 }}>
          One-click enable in Cloud Console, wait ~30 seconds for it to propagate, then try again.
        </div>
        <button
          type="button"
          onClick={open}
          className="btn-secondary"
          style={{
            fontSize: 12,
            padding: "4px 10px",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            textDecoration: "none",
          }}
        >
          <Icon.ExternalLink className="lucide-xs" />
          Open Cloud Console to enable
        </button>
      </div>
    </div>
  );
}

function FileCard({ card, onProcess, onDownload }) {
  const { filename, state, leads, error, results } = card;
  const leadCount = (leads || []).length;

  let statusLine = "Parsing…";
  if (state === "loaded") statusLine = `${leadCount} lead${leadCount === 1 ? "" : "s"} extracted`;
  if (state === "processing") statusLine = `Processing ${leadCount} lead${leadCount === 1 ? "" : "s"}…`;
  if (state === "done" && results) {
    const s = results.summary || {};
    statusLine = `Done — ${s.success || 0} success, ${s.partial || 0} partial, ${s.error || 0} error`;
  }
  if (state === "error") statusLine = error || "Upload failed";

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        background: "var(--bg-elev)",
        padding: 14,
        maxWidth: 560,
        marginBottom: 8,
      }}
    >
      <div className="flex items-center gap-3" style={{ marginBottom: state === "error" ? 0 : 12 }}>
        <Icon.FileText className="lucide-sm" style={{ color: "var(--fg-muted)", flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {filename}
          </div>
          <div style={{ fontSize: 12, color: state === "error" ? "var(--danger)" : "var(--fg-muted)", marginTop: 2 }}>
            {statusLine}
          </div>
        </div>
        {state === "processing" && <Icon.Loader className="lucide-sm spin" style={{ color: "var(--fg-muted)" }} />}
      </div>

      {state === "loaded" && (
        <div className="flex items-center gap-2" style={{ marginTop: 2 }}>
          <button
            className="btn-primary px-3 py-1.5"
            style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
            onClick={() => onProcess(card.id)}
          >
            <Icon.Zap className="lucide-xs" />
            Process all
          </button>
        </div>
      )}
      {state === "done" && (
        <div className="flex items-center gap-2" style={{ marginTop: 2 }}>
          <button
            className="btn-secondary px-3 py-1.5"
            style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}
            onClick={() => onDownload(card)}
          >
            <Icon.Download className="lucide-xs" />
            Download CSV
          </button>
        </div>
      )}
    </div>
  );
}

function Chat({
  assistantKey,                 // "personal" | "marketing" | custom agent slug
  mode,                         // "empty-first" | "empty-recurring" | "active"
  setMode,
  onTriggerPipeline,
  rightRailOpen,
  pipelineMinimized,
  onRestorePipeline,
  prefill,
  activeConversationUuid,       // null for new, otherwise uuid
  setActiveConversationUuid,    // (uuid | null) => void
}) {
  // Custom agent metadata isn't in Data.assistants — fetch on mount when the
  // slug isn't a built-in. Falls through to a synthesised stub so all the
  // existing `a.name`, `a.chips`, `a.icon` references keep working.
  const builtinKey = (assistantKey === "marketing" || assistantKey === "personal") ? assistantKey : null;
  const [customAgent, setCustomAgent] = useState(null);
  useEffect(() => {
    if (builtinKey) { setCustomAgent(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/agents/${encodeURIComponent(assistantKey)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setCustomAgent(data);
      } catch { /* keep stub a; chat still works against /chat */ }
    })();
    return () => { cancelled = true; };
  }, [assistantKey, builtinKey]);

  const a = builtinKey
    ? Data.assistants[builtinKey]
    : {
        key: assistantKey,
        name: customAgent?.name || assistantKey,
        blurb: (customAgent?.soul || "").slice(0, 80) || "Custom agent",
        icon: "Sparkles",
        chips: [],
        emptyGreetingBlurb: customAgent?.soul || "Custom agent.",
        activityToday: 0,
        recent: [],
      };
  const chips = a.chips;

  const [input, setInput] = useState(prefill || "");
  const [confirmReset, setConfirmReset] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loadError, setLoadError] = useState("");
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  // File-upload state (Marketing chat only). The uploaded batch lives on a
  // per-chat-session basis — we intentionally do not persist it to the
  // conversation DB for v1.14, so a reload clears the card.
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const isMarketing = assistantKey === "marketing";

  // Guided-setup modal. Two trigger paths:
  //   1. Marketing: Adam clicks Process all without Pomanda/Cognism/Lusha →
  //      pre-batch credential check.
  //   2. Either chat: Jackson attempts a tool call, backend returns a
  //      `needs_setup` signal in /chat or /tools/execute → modal pops up so
  //      Adam can configure on the spot.
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupMissing, setSetupMissing] = useState(["pomanda", "cognism", "lusha"]);
  const [setupContext, setSetupContext] = useState("");
  const [pendingCardId, setPendingCardId] = useState(null);
  // Per-conversation set of tools Adam has already declined to set up — once
  // dismissed, we don't re-pop the modal for the same tool until he resets the
  // chat. Pure UI state; doesn't persist past page reload.
  const [declinedSetups, setDeclinedSetups] = useState(() => new Set());

  // Reset messages + input when assistant changes.
  useEffect(() => {
    setMessages([]);
    setConfirmReset(false);
    setDeclinedSetups(new Set());
  }, [assistantKey]);

  // New conversation → clear per-conversation declined-setups so a fresh
  // chat can re-prompt for the same tool if Jackson hits the same wall.
  useEffect(() => {
    setDeclinedSetups(new Set());
  }, [activeConversationUuid]);

  // Trigger the SetupModal from a backend `needs_setup` signal. Returns true
  // when the modal was opened (so the caller can swap a generic error message
  // for a friendlier "let me show you how" line).
  const maybeTriggerSetup = (needs_setup) => {
    if (!needs_setup) return false;
    const tools = Array.isArray(needs_setup.tools) ? needs_setup.tools.filter(Boolean) : [];
    if (tools.length === 0) return false;
    // Skip if every tool was already declined this conversation.
    const fresh = tools.filter((t) => !declinedSetups.has(t));
    if (fresh.length === 0) return false;
    setSetupMissing(fresh);
    setSetupContext(needs_setup.context || "to use that tool");
    setPendingCardId(null);
    setSetupOpen(true);
    return true;
  };

  // Load conversation whenever the selected uuid changes.
  useEffect(() => {
    let cancelled = false;
    if (!activeConversationUuid) {
      setMessages([]);
      setLoadError("");
      return () => { cancelled = true; };
    }
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/conversations/${activeConversationUuid}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const loaded = (data.messages || []).map((m) => ({
          from: m.role === "assistant" ? "assistant" : "user",
          text: m.content,
          model_used: m.model_used,
        }));
        setMessages(loaded);
        setLoadError("");
        if (loaded.length > 0) setMode("active");
      } catch (_) {
        if (!cancelled) setLoadError("Couldn't load that conversation.");
      }
    })();
    return () => { cancelled = true; };
  }, [activeConversationUuid, setMode]);

  // Focus + prefill on first-run / recurring.
  useEffect(() => {
    if (mode !== "active" && inputRef.current) {
      inputRef.current.focus();
      if (prefill) {
        setInput(prefill);
        setTimeout(() => {
          const el = inputRef.current;
          if (el) el.selectionStart = el.selectionEnd = el.value.length;
        }, 0);
      }
    }
  }, [mode, assistantKey, prefill]);

  // Scroll to bottom only when a new message arrives or the last message's
  // text actually changes (covers streamed assistant updates). Re-renders
  // triggered by unrelated state — typing in the input, hover transitions —
  // must NOT yank the scroll position. v1.25's flicker symptom turned out
  // to be physical layout movement from this effect firing on every
  // keystroke; gating on growth/last-text-change is the actual fix.
  const scrollSnapshotRef = useRef({ len: 0, lastText: "" });
  useEffect(() => {
    const last = messages[messages.length - 1];
    const lastText = (last && (last.text || last.state || "")) || "";
    const prev = scrollSnapshotRef.current;
    const grew = messages.length > prev.len;
    const lastChanged = messages.length === prev.len && lastText !== prev.lastText;
    scrollSnapshotRef.current = { len: messages.length, lastText };
    if ((grew || lastChanged) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const updateUrl = (uuid) => {
    try {
      const url = new URL(window.location.href);
      if (uuid) url.searchParams.set("conversation", uuid);
      else url.searchParams.delete("conversation");
      window.history.pushState({}, "", url.toString());
    } catch (_) { /* ignore */ }
  };

  const handleSend = async (override) => {
    if (thinking) return;
    const raw = typeof override === "string" ? override : input;
    const v = raw.trim();
    if (!v) return;
    if (typeof override !== "string") setInput("");

    const lower = v.toLowerCase();
    const isPipeline =
      assistantKey === "marketing" && (
        lower.includes("enrich") ||
        (lower.includes("pull") && lower.includes("leads")) ||
        lower.includes("zint batch") ||
        lower === "demo"
      );

    if (mode !== "active") setMode("active");

    setMessages((m) => [...m, { from: "user", text: v }]);
    setThinking(true);
    if (isPipeline) onTriggerPipeline();

    // Built-in slugs route via the legacy modes; custom agents pass their
    // slug through verbatim and the backend's /chat resolves it via
    // _is_custom_agent_slug → SOUL.md preamble.
    const backendMode = (assistantKey === "marketing" || assistantKey === "personal")
      ? assistantKey
      : assistantKey;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: v,
          mode: backendMode,
          conversation_id: activeConversationUuid || null,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }
      const data = await res.json();
      setMessages((m) => [
        ...m,
        {
          from: "assistant",
          text: data.reply ?? "",
          model_used: data.model_used,
          // `needs_api_enable` rides on the message itself so the banner
          // renders alongside the (already-rewritten) reply text. Distinct
          // from `needs_setup`, which still goes to the SetupModal.
          needs_api_enable: data.needs_api_enable || null,
        },
      ]);

      if (data.conversation_id && data.conversation_id !== activeConversationUuid) {
        setActiveConversationUuid(data.conversation_id);
        updateUrl(data.conversation_id);
      }

      // Backend told us a tool needs configuring → pop SetupModal.
      maybeTriggerSetup(data.needs_setup);
    } catch (err) {
      let text;
      if (err && err.name === "AbortError") {
        text = "That took longer than expected. Try asking again.";
      } else if (err instanceof TypeError) {
        text = "I can't reach the local service. Make sure the app's backend is running.";
      } else {
        text = "Something went wrong. Check the app logs.";
      }
      setMessages((m) => [...m, { from: "assistant", text, error: true }]);
    } finally {
      clearTimeout(timeoutId);
      setThinking(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChipClick = (text) => {
    setInput(text);
    if (inputRef.current) {
      inputRef.current.focus();
      setTimeout(() => {
        const el = inputRef.current;
        if (el) el.selectionStart = el.selectionEnd = el.value.length;
      }, 0);
    }
  };

  const handleReset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setMessages([]);
    setMode("empty-recurring");
    setConfirmReset(false);
    setInput("");
    setActiveConversationUuid(null);
    updateUrl(null);
  };

  // --------------------------------------------------------------------------
  // File upload — Marketing chat. Routes the CSV through the v1.30 enrichment
  // pipeline (/enrichment/run, which returns a job_id immediately) and emits
  // a [[enrichment-progress:<job_id>]] marker that the chat splitter renders
  // as <EnrichmentProgressCard>. The card polls /enrichment/status/{id} and
  // swaps to a download link on completion.
  //
  // The legacy MAN-cascade path (Pomanda → Cognism → Lusha + SetupModal gate)
  // still lives in src/Workflows.jsx and uses /workflow/man/upload-spreadsheet
  // directly — leave processFileCard / _runFileCardBatch / "Process all" UI
  // intact for that page. The chat surface no longer touches them.
  // --------------------------------------------------------------------------

  const handleFilePick = async (file) => {
    if (!file) return;
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      setMessages((m) => [...m, {
        from: "assistant",
        text: "Excel files aren't supported yet — please export as CSV (File → Save As → CSV UTF-8) and drop it back in.",
        error: true,
      }]);
      if (mode !== "active") setMode("active");
      return;
    }
    if (!name.endsWith(".csv") && file.type !== "text/csv") {
      setMessages((m) => [...m, {
        from: "assistant",
        text: "Only .csv files are supported for lead batches.",
        error: true,
      }]);
      if (mode !== "active") setMode("active");
      return;
    }

    if (mode !== "active") setMode("active");

    // Show the user's "attachment" as a normal user message so the
    // conversation history reads naturally on reload.
    setMessages((m) => [...m, {
      from: "user",
      text: `📎 ${file.name}`,
    }]);

    // Placeholder while we POST — gives instant feedback before the
    // job_id comes back. Replaced (not appended) with the real assistant
    // message containing the progress marker.
    const placeholderId = `enr-${Date.now()}`;
    setMessages((m) => [...m, {
      from: "assistant",
      id: placeholderId,
      text: "Uploading…",
    }]);

    try {
      const text = await file.text();
      const res = await fetch(`${API_BASE}/enrichment/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv_content: text,
          filename: file.name,
          source_type: "csv",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.detail || `Upload failed (HTTP ${res.status}).`;
        setMessages((m) => m.map((msg) => msg.id === placeholderId
          ? { from: "assistant", text: detail, error: true }
          : msg
        ));
        return;
      }
      const jobId = data?.job_id;
      const total = data?.total || 0;
      const truncatedNote = data?.truncated
        ? "\n\n> _Capped at 200 rows — re-run with the rest if needed._"
        : "";
      const marker = jobId ? `[[enrichment-progress:${jobId}]]` : "";
      const reply = [
        `On it — enriching ${total} row${total === 1 ? "" : "s"}. I'll fill in the missing fields using Companies House first, then any other sources we have wired.`,
        "",
        marker,
      ].join("\n") + truncatedNote;
      setMessages((m) => m.map((msg) => msg.id === placeholderId
        ? { from: "assistant", text: reply }
        : msg
      ));
    } catch (err) {
      const msg = err instanceof TypeError
        ? "Can't reach the local backend. Is it running?"
        : (err?.message || "Upload failed.");
      setMessages((m) => m.map((mm) => mm.id === placeholderId
        ? { from: "assistant", text: msg, error: true }
        : mm
      ));
    }
  };

  const processFileCard = async (cardId) => {
    const card = messages.find((m) => m.id === cardId);
    if (!card || !card.leads?.length) return;

    // Gate on credentials — open the guided-setup modal if anything is missing.
    try {
      const statusRes = await fetch(`${API_BASE}/workflow/man/status`);
      const s = await statusRes.json();
      if (!s?.ready) {
        setSetupMissing(s?.missing || ["pomanda", "cognism", "lusha"]);
        setSetupContext(`to process ${card.leads.length} lead${card.leads.length === 1 ? "" : "s"}`);
        setPendingCardId(cardId);
        setSetupOpen(true);
        return;
      }
    } catch { /* fall through — run anyway; backend handles per-row errors */ }

    await _runFileCardBatch(cardId);
  };

  const _runFileCardBatch = async (cardId) => {
    const card = messages.find((m) => m.id === cardId);
    if (!card || !card.leads?.length) return;
    setMessages((m) => m.map((msg) => msg.id === cardId ? { ...msg, state: "processing" } : msg));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      const res = await fetch(`${API_BASE}/workflow/man/process-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: card.leads }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages((m) => m.map((msg) => msg.id === cardId
          ? { ...msg, state: "error", error: data?.detail || `Batch failed (HTTP ${res.status}).` }
          : msg
        ));
        return;
      }
      setMessages((m) => m.map((msg) => msg.id === cardId
        ? { ...msg, state: "done", results: data }
        : msg
      ));
      setMessages((m) => [...m, { from: "assistant", text: _summaryText(data, card) }]);
    } catch (err) {
      const msg = err?.name === "AbortError"
        ? "That took longer than 5 minutes. The backend may still be working — try a smaller batch."
        : err instanceof TypeError
          ? "Can't reach the local backend. Is it running?"
          : (err?.message || "Batch failed.");
      setMessages((m) => m.map((mm) => mm.id === cardId ? { ...mm, state: "error", error: msg } : mm));
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const downloadBatchCsv = (card) => {
    if (!card?.results) return;
    const originalCols = card.detected_columns || [];
    const enrichmentCols = [
      "verified_man_name", "verified_man_title", "verified_email", "verified_mobile",
      "man_source", "email_source", "mobile_source",
      "enrichment_status", "contact_status", "status",
      "credits_cognism_used", "credits_lusha_used", "notes",
    ];
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [[...originalCols, ...enrichmentCols].map(esc).join(",")];
    (card.leads || []).forEach((lead, i) => {
      const r = (card.results.results || [])[i];
      const orig = lead.original_row || {};
      const m = r?.man || {};
      const s = r?.sources || {};
      const cu = r?.credits_used || {};
      const row = [
        ...originalCols.map((c) => esc(orig[c] ?? "")),
        esc(m.name || ""), esc(m.job_title || m.role || ""),
        esc(m.email || ""), esc(m.mobile || ""),
        esc(s.man || ""), esc(s.email || ""), esc(s.mobile || ""),
        esc(r?.enrichment_status || ""), esc(r?.contact_status || ""), esc(r?.status || "missing"),
        esc(cu.cognism || 0), esc(cu.lusha || 0),
        esc(r?.error || ""),
      ];
      lines.push(row.join(","));
    });
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `man-results-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleChatDragOver = (e) => {
    if (!isMarketing) return;
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();
    setDragActive(true);
  };
  const handleChatDrop = (e) => {
    if (!isMarketing) return;
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFilePick(f);
  };

  const TopBar = () => (
    <div
      className="flex items-center justify-between px-6 py-3"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2" style={{ color: "var(--fg-muted)", fontSize: 13 }}>
        {mode === "active" ? (
          <span style={{ color: "var(--fg)" }}>{a.name}</span>
        ) : (
          <span>New conversation</span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          <span className="green-dot" />
          <span>Connected</span>
        </div>
        <div className="relative">
          <button className="btn-ghost p-1.5" onClick={() => setMenuOpen((o) => !o)}>
            <Icon.MoreHorizontal className="lucide-sm" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 mt-1 card py-1 slide-in-top"
              style={{ minWidth: 170, zIndex: 30 }}
              onMouseLeave={() => setMenuOpen(false)}
            >
              {[
                { label: "Export conversation", icon: "Download" },
                { label: "Clear this conversation", icon: "Trash" },
                { label: "Mission control", icon: "Settings" },
              ].map((it) => (
                <button
                  key={it.label}
                  className="w-full text-left px-3 py-1.5 flex items-center gap-2"
                  style={{ fontSize: 13, color: "var(--fg)" }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMenuOpen(false)}
                >
                  {React.createElement(Icon[it.icon], { className: "lucide-sm" })}
                  {it.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const EmptyFirstRun = () => (
    <div className="flex-1 flex flex-col items-center justify-center px-6 fade-in">
      <div className="w-full" style={{ maxWidth: 640 }}>
        <div className="text-center">
          <h1 className="font-serif-display" style={{ fontSize: 44, lineHeight: 1.1, color: "var(--fg)" }}>
            {a.name}.
          </h1>
          <p style={{ marginTop: 16, color: "var(--fg-muted)", fontSize: 16 }}>
            {a.emptyGreetingBlurb}
          </p>
        </div>

        <div className="mt-12">
          <div style={{ color: "var(--fg-faint)", fontSize: 13, marginBottom: 12 }}>
            Try saying one of these, or just type anything:
          </div>
          <div className="grid grid-cols-2 gap-3">
            {chips.map((c) => (
              <button
                key={c}
                className="chip text-left px-4 py-3"
                style={{ fontSize: 14, color: "var(--fg)" }}
                onClick={() => handleChipClick(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const EmptyRecurring = () => (
    <div className="flex-1 flex flex-col items-center justify-center px-6 fade-in">
      <div className="w-full" style={{ maxWidth: 640 }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--fg-faint)", marginBottom: 8 }}>
            {a.name}
          </div>
          <h1 className="font-serif-display" style={{ fontSize: 40, lineHeight: 1.1, color: "var(--fg)" }}>
            I'm ready when you are, Adam.
          </h1>
          <p style={{ marginTop: 12, color: "var(--fg-muted)", fontSize: 16 }}>
            What shall we start with?
          </p>
        </div>

        <div
          className="mt-8 bg-left-accent px-5 py-4 fade-in"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderLeftWidth: 2,
            borderLeftColor: "var(--accent-line)",
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 4 }}>
            Today at a glance
          </div>
          <div style={{ fontSize: 15, color: Data.briefing ? "var(--fg)" : "var(--fg-muted)", lineHeight: 1.6 }}>
            {Data.briefing || "Your daily briefing will appear here once your calendar and inbox are connected."}
          </div>
        </div>

        <div className="mt-8">
          <div style={{ color: "var(--fg-faint)", fontSize: 13, marginBottom: 12 }}>
            Or try one of these:
          </div>
          <div className="grid grid-cols-2 gap-3">
            {chips.map((c) => (
              <button
                key={c}
                className="chip text-left px-4 py-3"
                style={{ fontSize: 14, color: "var(--fg)" }}
                onClick={() => handleChipClick(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // NOT defined as a component (`const ActiveConvo = () => …`) — that
  // produces a fresh function identity on every Chat render, which makes
  // React unmount and remount the `<div ref={scrollRef}>` scroll container
  // on every keystroke. A new container has scrollTop=0, so the
  // conversation snaps back to the first message. Keeping this as a plain
  // JSX expression preserves the underlying DOM node and its scroll
  // position across re-renders.
  const activeConvoEl = (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: 720 }}>
        {loadError && (
          <div className="mb-6" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            {loadError}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"mb-6 flex " + (m.from === "user" ? "justify-end" : "justify-start") + " fade-in"}>
            {m.from === "file-card" ? (
              <FileCard card={m} onProcess={processFileCard} onDownload={downloadBatchCsv} />
            ) : m.from === "user" ? (
              <div className="user-msg msg-body" style={{ maxWidth: "85%", color: "var(--fg)" }}>
                {m.text.split("\n").map((line, j) => (
                  <p key={j}>{line}</p>
                ))}
              </div>
            ) : (
              <div
                style={{ maxWidth: "100%", width: "100%" }}
              >
                <div
                  className="msg-body"
                  style={{
                    color: m.error ? "var(--fg-muted)" : "var(--fg)",
                    lineHeight: 1.65,
                    borderLeft: m.error ? "2px solid var(--border-strong)" : "none",
                    paddingLeft: m.error ? 12 : 0,
                  }}
                >
                  {m.error
                    ? m.text.split("\n").map((line, j) =>
                        line.trim() === "" ? <p key={j}>&nbsp;</p> : <p key={j}>{line}</p>
                      )
                    : splitMessageBody(m.text).map((piece, j) => {
                        if (piece.kind === "card") {
                          return (
                            <ActionCard
                              key={`m-${i}-c-${j}-${piece.token}`}
                              token={piece.token}
                              onEditRequest={(text) => handleSend(text)}
                              onNeedsSetup={maybeTriggerSetup}
                            />
                          );
                        }
                        if (piece.kind === "enrichment") {
                          return (
                            <EnrichmentProgressCard
                              key={`m-${i}-e-${j}-${piece.jobId}`}
                              jobId={piece.jobId}
                            />
                          );
                        }
                        return (
                          <React.Fragment key={`m-${i}-t-${j}`}>
                            {renderMarkdown(piece.text, `m-${i}-t-${j}`)}
                          </React.Fragment>
                        );
                      })}
                </div>
                {m.needs_api_enable && <ApiEnableBanner info={m.needs_api_enable} />}
                {!m.error && <BrainPill model={m.model_used} />}
              </div>
            )}
          </div>
        ))}

        {thinking && (
          <div className="flex items-center gap-2 mt-2 mb-4">
            <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: 999, background: "var(--fg-faint)", display: "inline-block" }} />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      className="flex-1 flex flex-col min-w-0"
      style={{ background: "var(--bg)", position: "relative" }}
      onDragOver={handleChatDragOver}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleChatDrop}
    >
      <TopBar />

      {mode === "empty-first" && <EmptyFirstRun />}
      {mode === "empty-recurring" && <EmptyRecurring />}
      {mode === "active" && activeConvoEl}
      {isMarketing && dragActive && (
        <div
          style={{
            position: "absolute", inset: 0, zIndex: 10,
            background: "var(--accent-soft)",
            border: "2px dashed var(--accent)",
            borderRadius: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div className="flex items-center gap-3" style={{ fontSize: 15, fontWeight: 500, color: "var(--accent)" }}>
            <Icon.Upload className="lucide" />
            Drop CSV to upload
          </div>
        </div>
      )}

      <div className="px-6 pb-5 pt-2">
        <div className="mx-auto" style={{ maxWidth: 720 }}>
          <div className="chat-input-wrap px-4 py-2 flex items-end gap-2">
            {confirmReset ? (
              <div className="flex items-center gap-2 pr-1" style={{ fontSize: 13 }}>
                <span style={{ color: "var(--fg-muted)" }}>Clear this conversation?</span>
                <button onClick={handleReset} style={{ color: "var(--danger)", fontWeight: 500 }}>
                  Clear
                </button>
                <button onClick={() => setConfirmReset(false)} style={{ color: "var(--fg-muted)" }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={handleReset}
                className="btn-ghost px-2 py-1"
                style={{ fontSize: 13 }}
              >
                Reset
              </button>
            )}

            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              disabled={thinking}
              placeholder={thinking ? "Thinking…" : mode === "active" ? "Reply…" : "Type or say anything…"}
              style={{
                flex: 1,
                padding: "6px 4px",
                minHeight: 28,
                maxHeight: 140,
                overflowY: "auto",
                fontSize: 15,
                lineHeight: 1.5,
                opacity: thinking ? 0.6 : 1,
                cursor: thinking ? "not-allowed" : "text",
              }}
            />
            {isMarketing && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFilePick(f);
                    e.target.value = "";
                  }}
                  aria-label="Upload CSV lead batch"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="btn-ghost p-1.5"
                  disabled={thinking}
                  style={{ color: "var(--fg-muted)", cursor: thinking ? "not-allowed" : "pointer" }}
                  title="Attach a Zint CSV lead batch"
                  aria-label="Attach CSV"
                >
                  <Icon.Paperclip className="lucide-sm" />
                </button>
              </>
            )}
            <button
              onClick={handleSend}
              className="btn-ghost p-1.5"
              disabled={thinking || !input.trim()}
              style={{
                color: input.trim() && !thinking ? "var(--accent)" : "var(--fg-faint)",
                cursor: thinking || !input.trim() ? "not-allowed" : "pointer",
              }}
              title={thinking ? "Waiting for reply…" : "Send (Enter)"}
            >
              <Icon.Send className="lucide-sm" />
            </button>
          </div>

          {mode === "empty-first" && (
            <div className="text-center mt-3" style={{ fontSize: 12, color: "var(--fg-faint)" }}>
              Everything you say stays on this Mac Mini.
            </div>
          )}
        </div>
      </div>

      {pipelineMinimized && !rightRailOpen && (
        <div className="bg-status-dot" onClick={onRestorePipeline} title="Show progress">
          <span className="green-dot pulse-dot" />
          <span>Pipeline running — in progress</span>
          <Icon.ChevronRight className="lucide-xs" style={{ color: "var(--fg-muted)" }}/>
        </div>
      )}
      <SetupModal
        open={setupOpen}
        onClose={async () => {
          setSetupOpen(false);
          const cardId = pendingCardId;
          setPendingCardId(null);

          // Re-check what's still missing so we can be specific in the message
          // and remember which tools Adam decided not to configure.
          let stillMissing = [];
          try {
            const res = await fetch(`${API_BASE}/workflow/man/status`);
            const s = await res.json();
            stillMissing = setupMissing.filter((t) => {
              if (t === "ghl") return !s?.ghl_configured;
              if (t === "pomanda") return !s?.pomanda_configured;
              if (t === "cognism") return !s?.cognism_configured;
              if (t === "lusha") return !s?.lusha_configured;
              return false;
            });
          } catch { /* ignored — fall through to unknown state */ }

          if (cardId) {
            // Marketing pre-batch path: nudge that we're proceeding with what
            // Adam has, then run the batch.
            if (stillMissing.length > 0) {
              setMessages((m) => [...m, {
                from: "assistant",
                text: "Processing with available data. You can configure the missing tools later from the Workflows tab for complete results.",
              }]);
            }
            await _runFileCardBatch(cardId);
            return;
          }

          // Chat-triggered path: leave a friendly trail so Adam knows the
          // conversation isn't stuck, and remember which tools he skipped so
          // we don't keep popping the modal in this conversation.
          if (stillMissing.length > 0) {
            setDeclinedSetups((prev) => {
              const next = new Set(prev);
              stillMissing.forEach((t) => next.add(t));
              return next;
            });
            setMessages((m) => [...m, {
              from: "assistant",
              text: `No problem — let me know when you're ready to set ${stillMissing.length === 1 ? stillMissing[0].toUpperCase() : "those tools"} up.`,
            }]);
          } else {
            // Everything Adam was asked to configure is now connected.
            setMessages((m) => [...m, {
              from: "assistant",
              text: "Connected. Try that again whenever you're ready.",
            }]);
          }
        }}
        onConfigured={() => { /* keep modal open — user can continue the wizard */ }}
        requiredTools={setupMissing}
        context={setupContext}
      />
    </div>
  );
}

export default Chat;
