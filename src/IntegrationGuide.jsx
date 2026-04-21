import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// Marker emitted by the setup specialist in chat. We parse it out of the
// assistant's reply text and swap it for a real inline form component.
// Accepts both the raw form `[[credential-form:hubspot]]` and the
// code-fenced form ```credential-form:hubspot```.
const FORM_MARKER_RE = /(?:\[\[credential-form:([a-z0-9-]+)\]\])|(?:```credential-form:([a-z0-9-]+)```)/g;

const FORM_FIELDS = {
  "google-workspace": [
    { key: "client_id",     label: "Client ID",     password: true },
    { key: "client_secret", label: "Client Secret", password: true },
  ],
  hubspot: [
    { key: "token", label: "Private App Token", password: true },
  ],
  ghl: [
    { key: "api_key",        label: "API Key",                 password: true },
    { key: "sub_account_id", label: "Sub-account ID (optional)", password: true },
  ],
};

const TOOL_META = {
  "google-workspace": { label: "Google Workspace", icon: "Calendar" },
  "hubspot":          { label: "HubSpot",          icon: "Database" },
  "ghl":              { label: "GHL",              icon: "TrendingUp" },
};

function CredentialForm({ toolId, onSaved }) {
  const fields = FORM_FIELDS[toolId] || [];
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ""])));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { success, error? }
  const [oauthBusy, setOauthBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  const toolLabel = TOOL_META[toolId]?.label || toolId;

  const handleSave = async (e) => {
    e?.preventDefault?.();
    setSaveError("");
    // Drop empty optional fields.
    const payload = {};
    for (const f of fields) {
      const v = (values[f.key] || "").trim();
      if (v) payload[f.key] = v;
    }
    const required = fields.filter((f) => !/optional/i.test(f.label));
    for (const f of required) {
      if (!payload[f.key]) {
        setSaveError(`${f.label} is required.`);
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/integrations/${toolId}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials: payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setSaveError(err?.message || "Could not save to Keychain.");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${API_BASE}/integrations/${toolId}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
      setTestResult(data);
    } catch (err) {
      setTestResult({ success: false, error: err?.message || "Test failed." });
    } finally {
      setTesting(false);
    }
  };

  const handleAuthorize = async () => {
    setOauthBusy(true);
    try {
      const res = await fetch(`${API_BASE}/integrations/${toolId}/oauth-init`, { method: "POST" });
      const data = await res.json();
      if (data?.auth_url) {
        window.open(data.auth_url, "mc-oauth", "width=520,height=700");
      } else {
        setTestResult({ success: false, error: data?.detail || "Could not build auth URL." });
      }
    } catch (err) {
      setTestResult({ success: false, error: err?.message || "Could not start OAuth." });
    } finally {
      setOauthBusy(false);
    }
  };

  const isGoogle = toolId === "google-workspace";

  return (
    <div
      className="my-2"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: 16,
        background: "var(--bg-elev)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>
        {toolLabel} credentials
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 12, lineHeight: 1.5 }}>
        Values go straight to macOS Keychain. They never touch the chat history, the database, or Anthropic.
      </div>
      <form onSubmit={handleSave} className="flex flex-col gap-3">
        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>{f.label}</span>
            <input
              type={f.password ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              value={values[f.key] || ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              disabled={saving || saved}
              style={{
                padding: "8px 10px",
                fontSize: 13,
                border: "1px solid var(--border-strong)",
                borderRadius: 6,
                background: "var(--bg)",
                color: "var(--fg)",
              }}
            />
          </label>
        ))}
        {saveError && (
          <div style={{ fontSize: 12, color: "var(--danger)" }}>{saveError}</div>
        )}
        <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 4 }}>
          {!saved && (
            <button
              type="submit"
              className="btn-primary px-3 py-1.5"
              disabled={saving}
              style={{ fontSize: 13 }}
            >
              {saving ? "Saving…" : "Save to Keychain"}
            </button>
          )}
          {saved && isGoogle && (
            <button
              type="button"
              className="btn-primary px-3 py-1.5"
              onClick={handleAuthorize}
              disabled={oauthBusy}
              style={{ fontSize: 13 }}
            >
              {oauthBusy ? "Opening…" : "Authorize"}
            </button>
          )}
          {saved && (
            <button
              type="button"
              className="btn-secondary px-3 py-1.5"
              onClick={handleTest}
              disabled={testing}
              style={{ fontSize: 13 }}
            >
              {testing ? "Testing…" : "Test Connection"}
            </button>
          )}
          {testResult && testResult.success && (
            <span className="flex items-center gap-1" style={{ fontSize: 12, color: "var(--green)" }}>
              <Icon.Check className="lucide-xs" /> Connected
            </span>
          )}
          {testResult && !testResult.success && (
            <span style={{ fontSize: 12, color: "var(--danger)" }}>
              {testResult.error || "Test failed."}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

// Render assistant text with inline CredentialForm replacements.
function renderAssistantText(text, onFormSaved) {
  if (!text) return null;
  const parts = [];
  let last = 0;
  let m;
  const re = new RegExp(FORM_MARKER_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) });
    const toolId = m[1] || m[2];
    parts.push({ kind: "form", toolId });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });

  return parts.map((p, i) => {
    if (p.kind === "form") {
      return (
        <CredentialForm
          key={`f-${i}-${p.toolId}`}
          toolId={p.toolId}
          onSaved={() => onFormSaved?.(p.toolId)}
        />
      );
    }
    return (
      <div key={`t-${i}`} className="msg-body" style={{ color: "var(--fg)", lineHeight: 1.65 }}>
        {p.text.split("\n").map((line, j) =>
          line.trim() === "" ? <p key={j}>&nbsp;</p> : <p key={j}>{line}</p>
        )}
      </div>
    );
  });
}

function ToolRail({ tools, activeId, onSelect, loading }) {
  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{ width: 240, borderRight: "1px solid var(--border)", background: "var(--bg)" }}
    >
      <div className="px-4 pt-4 pb-2" style={{ fontSize: 12, color: "var(--fg-faint)", letterSpacing: "0.02em" }}>
        Tools
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-1">
        {loading && tools.length === 0 && (
          <div className="px-2 py-4" style={{ fontSize: 13, color: "var(--fg-faint)" }}>Loading…</div>
        )}
        {tools.map((t) => {
          const meta = TOOL_META[t.id] || {};
          const IconCmp = Icon[meta.icon] || Icon.Plug;
          const isActive = activeId === t.id;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={"tab-row " + (isActive ? "active" : "")}
              style={{ textAlign: "left" }}
            >
              <IconCmp className="lucide-sm" />
              <span className="flex-1 truncate">{t.label || meta.label || t.id}</span>
              {t.connected ? (
                <span className="flex items-center gap-1" style={{ fontSize: 11, color: "var(--green)" }}>
                  <span className="green-dot" /> Connected
                </span>
              ) : (
                <span style={{ fontSize: 11, color: "var(--fg-faint)" }}>Not connected</span>
              )}
            </button>
          );
        })}
        <div className="px-2 py-3" style={{ fontSize: 11, color: "var(--fg-faint)" }}>
          More tools coming soon.
        </div>
      </div>
    </div>
  );
}

function SetupChat({ toolId, onIntegrationChanged }) {
  const [messages, setMessages] = useState([]);      // {from, text, model_used?}
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const scrollRef = useRef(null);

  // Reset + send preset opener whenever tool changes.
  useEffect(() => {
    if (!toolId) return;
    setMessages([]);
    setConversationId(null);
    const preset = `I'd like to integrate ${TOOL_META[toolId]?.label || toolId}`;
    // Fire and forget — the async send will populate messages.
    send(preset, null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking]);

  const send = async (textOverride, forceConvoId, isPreset = false) => {
    const v = (textOverride ?? input).trim();
    if (!v || thinking) return;
    if (!isPreset) setInput("");
    setMessages((m) => [...m, { from: "user", text: v }]);
    setThinking(true);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: v,
          mode: "setup",
          conversation_id: forceConvoId ?? conversationId,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages((m) => [...m, { from: "assistant", text: data.reply ?? "", model_used: data.model_used }]);
      if (data.conversation_id && data.conversation_id !== conversationId) {
        setConversationId(data.conversation_id);
      }
    } catch (err) {
      let text;
      if (err?.name === "AbortError") text = "That took longer than expected. Try asking again.";
      else if (err instanceof TypeError) text = "I can't reach the local service. Is the backend running?";
      else text = "Something went wrong. Check the app logs.";
      setMessages((m) => [...m, { from: "assistant", text, error: true }]);
    } finally {
      clearTimeout(timeout);
      setThinking(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--bg)" }}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto px-6 py-6" style={{ maxWidth: 720 }}>
          {messages.length === 0 && !thinking && (
            <div className="flex-1 flex items-center justify-center" style={{ minHeight: 300, color: "var(--fg-muted)", fontSize: 14 }}>
              Pick a tool from the left to start.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={"mb-5 flex " + (m.from === "user" ? "justify-end" : "justify-start") + " fade-in"}>
              {m.from === "user" ? (
                <div className="user-msg msg-body" style={{ maxWidth: "85%", color: "var(--fg)" }}>
                  {m.text.split("\n").map((line, j) => <p key={j}>{line}</p>)}
                </div>
              ) : m.error ? (
                <div
                  className="msg-body"
                  style={{
                    width: "100%",
                    color: "var(--fg-muted)",
                    borderLeft: "2px solid var(--border-strong)",
                    paddingLeft: 12,
                  }}
                >
                  {m.text}
                </div>
              ) : (
                <div style={{ width: "100%" }}>
                  {renderAssistantText(m.text, onIntegrationChanged)}
                </div>
              )}
            </div>
          ))}
          {thinking && (
            <div className="flex items-center gap-2">
              <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: 999, background: "var(--fg-faint)", display: "inline-block" }} />
            </div>
          )}
        </div>
      </div>

      <div className="px-6 pb-5 pt-2">
        <div className="mx-auto" style={{ maxWidth: 720 }}>
          <div className="chat-input-wrap px-4 py-2 flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              disabled={thinking}
              placeholder={thinking ? "Thinking…" : "Ask a question or say 'ready for next step'…"}
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
              onClick={() => send()}
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
        </div>
      </div>
    </div>
  );
}

function IntegrationGuide() {
  const [tools, setTools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(null);
  const [fetchError, setFetchError] = useState("");

  const reload = async () => {
    try {
      const res = await fetch(`${API_BASE}/integrations`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTools(data.integrations || []);
      setFetchError("");
    } catch (err) {
      setTools([]);
      setFetchError(err?.message || "Could not reach the backend.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const initialTool = useMemo(() => tools[0]?.id || null, [tools]);
  useEffect(() => {
    if (!activeId && initialTool) setActiveId(initialTool);
  }, [activeId, initialTool]);

  return (
    <div className="flex-1 flex min-h-0">
      <ToolRail
        tools={tools}
        activeId={activeId}
        onSelect={setActiveId}
        loading={loading}
      />
      {activeId ? (
        <SetupChat toolId={activeId} onIntegrationChanged={reload} />
      ) : (
        <div className="flex-1 flex items-center justify-center" style={{ color: "var(--fg-muted)", fontSize: 14 }}>
          {fetchError || "Pick a tool from the left to start."}
        </div>
      )}
    </div>
  );
}

export default IntegrationGuide;
