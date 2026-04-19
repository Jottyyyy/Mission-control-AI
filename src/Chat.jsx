// Center column chat
const { useState: chUseState, useEffect: chUseEffect, useRef: chUseRef } = React;

function getGreetingTime() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

function Chat({
  assistantKey,    // "personal" | "marketing"
  mode,            // "empty-first" | "empty-recurring" | "active"
  setMode,
  onTriggerPipeline,
  rightRailOpen,
  pipelineMinimized,
  onRestorePipeline,
  prefill,         // optional string to prefill input
}) {
  const a = Data.assistants[assistantKey];
  const chips = a.chips;
  const seed = Data.seedMessages[assistantKey] || [];

  const [input, setInput] = chUseState(prefill || "");
  const [confirmReset, setConfirmReset] = chUseState(false);
  const [menuOpen, setMenuOpen] = chUseState(false);
  const [thinking, setThinking] = chUseState(false);
  const [messages, setMessages] = chUseState(() => seed.slice());
  const [briefingExpanded, setBriefingExpanded] = chUseState(false);
  const inputRef = chUseRef(null);
  const scrollRef = chUseRef(null);

  // Reset messages when assistant changes
  chUseEffect(() => {
    setMessages(Data.seedMessages[assistantKey] ? Data.seedMessages[assistantKey].slice() : []);
  }, [assistantKey]);

  // Focus input on first-run + recurring
  chUseEffect(() => {
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

  // Scroll to bottom when messages change (active mode)
  chUseEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, thinking, mode]);

  const handleSend = () => {
    const v = input.trim();
    if (!v) return;
    setInput("");

    // Pipeline demo trigger (only for marketing)
    const lower = v.toLowerCase();
    const isPipeline =
      assistantKey === "marketing" && (
        lower.includes("enrich") ||
        (lower.includes("pull") && lower.includes("leads")) ||
        lower.includes("zint batch") ||
        lower === "demo"
      );

    // Move out of empty into active
    if (mode !== "active") setMode("active");

    setMessages((m) => [...m, { from: "user", text: v }]);
    setThinking(true);

    setTimeout(() => {
      setThinking(false);
      if (isPipeline) {
        setMessages((m) => [
          ...m,
          {
            from: "assistant",
            text:
              "On it. Pulling the 50-company Zint batch and finding the MAN at each, then enriching contacts. I'll keep the progress in the side panel — feel free to carry on.",
          },
        ]);
        onTriggerPipeline();
      } else {
        setMessages((m) => [
          ...m,
          {
            from: "assistant",
            text:
              "Got it. I'll take a look and come back in a moment with a short answer.",
          },
        ]);
      }
    }, 900);
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
      // place cursor at end
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
  };

  // Top bar
  const TopBar = () => (
    <div
      className="flex items-center justify-between px-6 py-3"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-2" style={{ color: "var(--fg-muted)", fontSize: 13 }}>
        {mode === "active" ? (
          <span style={{ color: "var(--fg)" }}>
            {assistantKey === "marketing" ? "Acme Manufacturing enrichment" : "Morning briefing"}
          </span>
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

  // Empty first-run content
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

  // Empty recurring content
  const EmptyRecurring = () => (
    <div className="flex-1 flex flex-col items-center justify-center px-6 fade-in">
      <div className="w-full" style={{ maxWidth: 640 }}>
        <div>
          <div style={{ fontSize: 13, color: "var(--fg-faint)", marginBottom: 8 }}>
            {a.name}
          </div>
          <h1 className="font-serif-display" style={{ fontSize: 40, lineHeight: 1.1, color: "var(--fg)" }}>
            What's on your mind, Adam?
          </h1>
        </div>

        <div
          className="mt-8 bg-left-accent px-5 py-4 fade-in"
          style={{
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderLeftWidth: 2,
            borderLeftColor: "var(--accent-line)",
            borderRadius: 8,
            cursor: briefingExpanded ? "default" : "pointer",
          }}
          onClick={() => !briefingExpanded && setBriefingExpanded(true)}
        >
          <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 4 }}>
            Today at a glance
          </div>
          <div style={{ fontSize: 15, color: "var(--fg)", lineHeight: 1.6 }}>
            {Data.briefing}
          </div>
          {briefingExpanded && (
            <div className="mt-4 slide-in-top" style={{ fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.6 }}>
              <div><span style={{ color: "var(--fg)" }}>11:00</span> — Reynolds (prep ready)</div>
              <div><span style={{ color: "var(--fg)" }}>14:00</span> — Internal</div>
              <div><span style={{ color: "var(--fg)" }}>16:30</span> — Cotswold</div>
              <div className="mt-2">Acme replied at 22:41 and Pennine at 07:08 — both want to keep talking.</div>
            </div>
          )}
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

  // Active conversation
  const ActiveConvo = () => (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: 720 }}>
        {messages.map((m, i) => (
          <div key={i} className={"mb-6 flex " + (m.from === "user" ? "justify-end" : "justify-start") + " fade-in"}>
            {m.from === "user" ? (
              <div className="user-msg msg-body" style={{ maxWidth: "85%", color: "var(--fg)" }}>
                {m.text.split("\n").map((line, j) => (
                  <p key={j}>{line}</p>
                ))}
              </div>
            ) : (
              <div className="msg-body" style={{ maxWidth: "100%", color: "var(--fg)", lineHeight: 1.65 }}>
                {m.text.split("\n").map((line, j) =>
                  line.trim() === "" ? <p key={j}>&nbsp;</p> : <p key={j}>{line}</p>
                )}
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

      {/* Chat input */}
      <div className="px-6 pb-5 pt-2">
        <div className="mx-auto" style={{ maxWidth: 720 }}>
          <div className="chat-input-wrap px-4 py-2 flex items-end gap-2">
            {/* Reset button */}
            {confirmReset ? (
              <div className="flex items-center gap-2 pr-1" style={{ fontSize: 13 }}>
                <span style={{ color: "var(--fg-muted)" }}>Clear this conversation?</span>
                <button
                  onClick={handleReset}
                  style={{ color: "var(--danger)", fontWeight: 500 }}
                >
                  Clear
                </button>
                <button
                  onClick={() => setConfirmReset(false)}
                  style={{ color: "var(--fg-muted)" }}
                >
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
              placeholder={mode === "active" ? "Reply…" : "Type or say anything…"}
              style={{
                flex: 1,
                padding: "6px 4px",
                minHeight: 28,
                maxHeight: 140,
                overflowY: "auto",
                fontSize: 15,
                lineHeight: 1.5,
              }}
            />
            <button
              onClick={handleSend}
              className="btn-ghost p-1.5"
              style={{
                color: input.trim() ? "var(--accent)" : "var(--fg-faint)",
              }}
              title="Send (Enter)"
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

      {/* Minimized pipeline indicator */}
      {pipelineMinimized && !rightRailOpen && (
        <div className="bg-status-dot" onClick={onRestorePipeline} title="Show progress">
          <span className="green-dot pulse-dot" />
          <span>Enriching leads — in progress</span>
          <Icon.ChevronRight className="lucide-xs" style={{ color: "var(--fg-muted)" }}/>
        </div>
      )}
    </div>
  );
}

window.Chat = Chat;
