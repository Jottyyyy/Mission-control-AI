import React, { useState, useEffect, useRef } from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';
import { renderMarkdown } from './markdown.jsx';
import ActionCard, { splitByActionCards } from './ActionCard.jsx';

const API_BASE = "http://127.0.0.1:8001";

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

function Chat({
  assistantKey,                 // "personal" | "marketing"
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
  const a = Data.assistants[assistantKey];
  const chips = a.chips;

  const [input, setInput] = useState(prefill || "");
  const [confirmReset, setConfirmReset] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [messages, setMessages] = useState([]);
  const [loadError, setLoadError] = useState("");
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  // Reset messages + input when assistant changes.
  useEffect(() => {
    setMessages([]);
    setConfirmReset(false);
  }, [assistantKey]);

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

  // Scroll to bottom on message change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, thinking, mode]);

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

    const backendMode = assistantKey === "marketing" ? "marketing" : "personal";

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
        { from: "assistant", text: data.reply ?? "", model_used: data.model_used },
      ]);

      if (data.conversation_id && data.conversation_id !== activeConversationUuid) {
        setActiveConversationUuid(data.conversation_id);
        updateUrl(data.conversation_id);
      }
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

  const ActiveConvo = () => (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: 720 }}>
        {loadError && (
          <div className="mb-6" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            {loadError}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"mb-6 flex " + (m.from === "user" ? "justify-end" : "justify-start") + " fade-in"}>
            {m.from === "user" ? (
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
                    : splitByActionCards(m.text).map((piece, j) =>
                        piece.kind === "card" ? (
                          <ActionCard
                            key={`m-${i}-c-${j}-${piece.token}`}
                            token={piece.token}
                            onEditRequest={(text) => handleSend(text)}
                          />
                        ) : (
                          <React.Fragment key={`m-${i}-t-${j}`}>
                            {renderMarkdown(piece.text, `m-${i}-t-${j}`)}
                          </React.Fragment>
                        )
                      )}
                </div>
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
    <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--bg)" }}>
      <TopBar />

      {mode === "empty-first" && <EmptyFirstRun />}
      {mode === "empty-recurring" && <EmptyRecurring />}
      {mode === "active" && <ActiveConvo />}

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
    </div>
  );
}

export default Chat;
