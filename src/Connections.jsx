import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';
import { renderMarkdown } from './markdown.jsx';

// Event name duplicated from App.jsx (can't import — would create a cycle
// through MissionControl). If this string ever changes, update both sides.
const REOPEN_ONBOARDING_EVENT = "mc:reopen-onboarding";

// --- Catalogue ------------------------------------------------------------
// Single source of truth for every tool shown in this tab. "ready" tools have
// a backend /integrations/<id>/* flow and a SKILL.md behind the Manual panel;
// "coming_soon" tools render a stub card. Adding a real integration later
// means: register it in the backend, add a SKILL.md, flip status to "ready".

const TOOLS = [
  // Ready to connect — live integrations wired to the backend.
  { id: "google-workspace", name: "Google Workspace", icon: "Calendar",   status: "ready",       hasSkill: true,  description: "Calendar, Gmail, Drive, Contacts" },
  { id: "hubspot",          name: "HubSpot",          icon: "Database",   status: "ready",       hasSkill: true,  description: "Sync leads and deals" },
  { id: "ghl",              name: "GoHighLevel",      icon: "TrendingUp", status: "ready",       hasSkill: true,  description: "Marketing CRM and outreach" },
  { id: "pomanda",          name: "Pomanda",          icon: "Building",   status: "ready",       hasSkill: true,  description: "Companies House + shareholder data for MAN" },
  { id: "cognism",          name: "Cognism",          icon: "Users",      status: "ready",       hasSkill: true,  description: "Primary B2B contact enrichment" },
  { id: "lusha",            name: "Lusha",            icon: "Users",      status: "ready",       hasSkill: true,  description: "Premium enrichment fallback" },

  // Coming soon — surfaced so Adam can see the roadmap and ask the AI about them.
  { id: "gmail",              name: "Gmail (via Workspace)",    icon: "Mail",          status: "coming_soon", hasSkill: false, description: "Read and draft emails" },
  { id: "calendar",           name: "Calendar (via Workspace)", icon: "Calendar",      status: "coming_soon", hasSkill: false, description: "Your schedule and meetings" },
  { id: "drive-workspace",    name: "Drive (via Workspace)",    icon: "Folder",        status: "coming_soon", hasSkill: false, description: "Files and shared documents" },
  { id: "notes",              name: "Notes (via Workspace)",    icon: "NotebookPen",   status: "coming_soon", hasSkill: false, description: "Capture and recall thoughts" },
  { id: "rocketreach",        name: "RocketReach",              icon: "Users",         status: "coming_soon", hasSkill: false, description: "Contact enrichment" },
  { id: "surfe",              name: "Surfe",                    icon: "RefreshCw",     status: "coming_soon", hasSkill: false, description: "CRM two-way sync" },
  { id: "zint",               name: "Zint data",                icon: "Database",      status: "coming_soon", hasSkill: false, description: "Companies House + UK filings" },
  { id: "fame",               name: "Fame data",                icon: "Briefcase",     status: "coming_soon", hasSkill: false, description: "UK financials for lead qualification" },
  { id: "slack",              name: "Slack",                    icon: "Slack",         status: "coming_soon", hasSkill: false, description: "Read channels, draft replies" },
  { id: "whatsapp-business",  name: "WhatsApp Business",        icon: "MessageSquare", status: "coming_soon", hasSkill: false, description: "Business messaging (drafts only)" },
  { id: "linkedin",           name: "LinkedIn",                 icon: "Linkedin",      status: "coming_soon", hasSkill: false, description: "Profile research and outreach drafts" },
  { id: "salesforce",         name: "Salesforce",               icon: "Briefcase",     status: "coming_soon", hasSkill: false, description: "Opportunity pipeline sync" },
  { id: "xero",               name: "Xero",                     icon: "FileText",      status: "coming_soon", hasSkill: false, description: "Accounts and invoices" },
  { id: "dropbox",            name: "Dropbox",                  icon: "Folder",        status: "coming_soon", hasSkill: false, description: "Read your documents" },
  { id: "zoom",               name: "Zoom",                     icon: "Video",         status: "coming_soon", hasSkill: false, description: "Join meetings and summarise" },
  { id: "google-drive",       name: "Google Drive",             icon: "Folder",        status: "coming_soon", hasSkill: false, description: "Search files by meaning" },
];

const toolById = (id) => TOOLS.find((t) => t.id === id) || null;

// --- Credential forms -----------------------------------------------------
// Only "ready" tools have forms. Moved here from the old IntegrationGuide.jsx.

const FORM_MARKER_RE = /`?(?:\[\[credential-form:([a-z0-9-]+)\]\])`?|`{3}credential-form:([a-z0-9-]+)`{3}/g;

const FORM_FIELDS = {
  "google-workspace": [
    { key: "client_id",     label: "Client ID",     password: true },
    { key: "client_secret", label: "Client Secret", password: true },
  ],
  hubspot: [
    { key: "token", label: "Private App Token", password: true },
  ],
  ghl: [
    { key: "api_key",     label: "Private Integration Token", password: true,
      placeholder: "pit-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
    { key: "location_id", label: "Location ID",               password: false,
      placeholder: "Found in Settings → Business Profile" },
  ],
  pomanda: [{ key: "api_key", label: "API Key", password: true }],
  cognism: [{ key: "api_key", label: "API Key", password: true }],
  lusha:   [{ key: "api_key", label: "API Key", password: true }],
};

function CredentialForm({ toolId, onSaved }) {
  const fields = FORM_FIELDS[toolId] || [];
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ""])));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  const toolLabel = toolById(toolId)?.name || toolId;

  const handleSave = async (e) => {
    e?.preventDefault?.();
    setSaveError("");
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
              placeholder={f.placeholder || ""}
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
            <button type="submit" className="btn-primary px-3 py-1.5" disabled={saving} style={{ fontSize: 13 }}>
              {saving ? "Saving…" : "Save to Keychain"}
            </button>
          )}
          {saved && isGoogle && (
            <button type="button" className="btn-primary px-3 py-1.5" onClick={handleAuthorize} disabled={oauthBusy} style={{ fontSize: 13 }}>
              {oauthBusy ? "Opening…" : "Authorize"}
            </button>
          )}
          {saved && (
            <button type="button" className="btn-secondary px-3 py-1.5" onClick={handleTest} disabled={testing} style={{ fontSize: 13 }}>
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

function renderWithForms(text, { keyPrefix, onFormSaved }) {
  if (!text) return null;
  const re = new RegExp(FORM_MARKER_RE.source, "g");
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) });
    parts.push({ kind: "form", toolId: m[1] || m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });

  return parts.map((p, i) => {
    if (p.kind === "form") {
      return (
        <CredentialForm
          key={`${keyPrefix}-f-${i}-${p.toolId}`}
          toolId={p.toolId}
          onSaved={() => onFormSaved?.(p.toolId)}
        />
      );
    }
    return (
      <div key={`${keyPrefix}-t-${i}`}>
        {renderMarkdown(p.text, `${keyPrefix}-t-${i}`)}
      </div>
    );
  });
}

// --- Pill tabs (Manual / Ask AI) ------------------------------------------
function PillTabs({ active, onChange }) {
  const tabs = [
    { id: "manual", label: "Manual", icon: Icon.FileText },
    { id: "chat",   label: "Ask AI", icon: Icon.Sparkles },
  ];
  return (
    <div
      className="flex items-center gap-1 p-1"
      style={{
        alignSelf: "flex-start",
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderRadius: 999,
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        const IconCmp = t.icon;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="flex items-center gap-1.5 px-3 py-1"
            style={{
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              color: isActive ? "var(--fg)" : "var(--fg-muted)",
              background: isActive ? "var(--bg)" : "transparent",
              border: isActive ? "1px solid var(--border)" : "1px solid transparent",
              borderRadius: 999,
              cursor: "pointer",
              transition: "background 120ms, color 120ms",
            }}
          >
            {IconCmp && <IconCmp className="lucide-xs" />}
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// --- Manual panel: SKILL.md render for ready tools ------------------------
function ManualPanel({ tool, onIntegrationChanged }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setContent("");
    const path = `agents/setup/skills/${tool.id}/SKILL.md`;
    fetch(`${API_BASE}/workspace/file?path=${encodeURIComponent(path)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => { if (!cancelled) setContent(data.content || ""); })
      .catch((err) => { if (!cancelled) setError(err?.message || "Couldn't load the manual."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tool.id]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-4" style={{ maxWidth: 760 }}>
        {loading && <div style={{ fontSize: 13, color: "var(--fg-faint)" }}>Loading the manual…</div>}
        {error && (
          <div style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}>{error}</div>
        )}
        {!loading && !error && (
          <div>
            {renderWithForms(content, {
              keyPrefix: `manual-${tool.id}`,
              onFormSaved: () => onIntegrationChanged?.(),
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Coming-soon Manual stub ---------------------------------------------
function ComingSoonManual({ tool, onAskAi }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-6" style={{ maxWidth: 640 }}>
        <div
          className="card p-6"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 12,
            background: "var(--bg-elev)",
          }}
        >
          <div className="flex items-center gap-3" style={{ marginBottom: 10 }}>
            {React.createElement(Icon[tool.icon] || Icon.Plug, { className: "lucide-sm", style: { color: "var(--fg-muted)" } })}
            <h3 style={{ fontSize: 18, fontWeight: 500, color: "var(--fg)", margin: 0 }}>{tool.name}</h3>
          </div>
          <p style={{ fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.6, margin: "0 0 14px" }}>
            {tool.description}
          </p>
          <p style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.6, margin: "0 0 10px" }}>
            Setup guide coming soon. Once we've wired this integration properly, the step-by-step manual will appear here.
          </p>
          <p style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.6, margin: "0 0 16px" }}>
            In the meantime, you can ask the AI about what this tool does or whether a workaround exists.
          </p>
          <button
            type="button"
            onClick={onAskAi}
            className="btn-secondary px-3 py-1.5"
            style={{ fontSize: 13 }}
          >
            <span className="flex items-center gap-1.5">
              <Icon.Sparkles className="lucide-xs" /> Ask AI about {tool.name}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Setup / Ask-AI chat (no auto-prompt) ---------------------------------
function SetupChat({ tool, onIntegrationChanged }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const scrollRef = useRef(null);

  // Reset on tool change — never auto-send. Adam types first.
  useEffect(() => {
    setMessages([]);
    setConversationId(null);
    setInput("");
  }, [tool.id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking]);

  const send = async () => {
    const v = input.trim();
    if (!v || thinking) return;
    setInput("");
    setMessages((m) => [...m, { from: "user", text: v }]);
    setThinking(true);

    // Invisible tool tag so the setup specialist knows which tool we're on
    // even if Adam's question doesn't name it.
    const taggedMessage = `[tool: ${tool.id}] ${v}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: taggedMessage,
          mode: "setup",
          conversation_id: conversationId,
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
        <div className="mx-auto px-6 py-4" style={{ maxWidth: 760 }}>
          {messages.length === 0 && !thinking && (
            <div
              className="mb-4 px-4 py-3"
              style={{
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 13,
                color: "var(--fg-muted)",
                lineHeight: 1.55,
              }}
            >
              Hit a snag? Ask anything about {tool.name} setup.
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
                  {renderWithForms(m.text, {
                    keyPrefix: `chat-${i}`,
                    onFormSaved: () => onIntegrationChanged?.(),
                  })}
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
        <div className="mx-auto" style={{ maxWidth: 760 }}>
          <div className="chat-input-wrap px-4 py-2 flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              rows={1}
              disabled={thinking}
              placeholder={thinking ? "Thinking…" : `Ask about ${tool.name} setup…`}
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
              onClick={send}
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

// --- Right pane: header + pill tabs + active panel ------------------------
function ToolPanel({ tool, onIntegrationChanged }) {
  const [panelTab, setPanelTab] = useState("manual");
  useEffect(() => { setPanelTab("manual"); }, [tool.id]);

  return (
    <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--bg)" }}>
      <div
        className="flex items-center justify-between px-6 py-3"
        style={{ borderBottom: "1px solid var(--border)", gap: 16 }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--fg)" }}>{tool.name}</div>
          {tool.status === "coming_soon" && (
            <span
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                border: "1px solid var(--border-strong)",
                color: "var(--fg-faint)",
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }}
            >
              Coming soon
            </span>
          )}
        </div>
        <PillTabs active={panelTab} onChange={setPanelTab} />
      </div>

      {panelTab === "manual" && tool.status === "ready" && (
        <ManualPanel tool={tool} onIntegrationChanged={onIntegrationChanged} />
      )}
      {panelTab === "manual" && tool.status === "coming_soon" && (
        <ComingSoonManual tool={tool} onAskAi={() => setPanelTab("chat")} />
      )}
      {panelTab === "chat" && (
        <SetupChat tool={tool} onIntegrationChanged={onIntegrationChanged} />
      )}
    </div>
  );
}

// --- Welcome state (no tool selected) -------------------------------------
function Welcome({ connectedCount, readyCount, comingSoonCount }) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="px-8 py-10 text-center" style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 22, fontWeight: 500, margin: "0 0 10px", color: "var(--fg)" }}>
          Connections
        </h2>
        <p style={{ fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.6, margin: "0 0 20px" }}>
          Your tools, all in one place. Pick one from the left to see its setup guide or ask the AI for help.
        </p>
        <div
          className="flex items-center justify-center gap-4 flex-wrap"
          style={{ fontSize: 12, color: "var(--fg-faint)" }}
        >
          <span className="flex items-center gap-1.5">
            <span className="green-dot" /> {connectedCount} connected
          </span>
          <span>·</span>
          <span>{readyCount} ready to set up</span>
          <span>·</span>
          <span>{comingSoonCount} coming soon</span>
        </div>
      </div>
    </div>
  );
}

// --- AI Provider card -----------------------------------------------------
// Lives at the top of the left rail so Adam can always see what brain is
// wired up. Reconfigure re-opens the onboarding flow without a terminal.

function AiProviderCard() {
  const [status, setStatus] = useState(null); // null = loading
  const [error, setError] = useState("");

  const load = async () => {
    setError("");
    try {
      const res = await fetch(`${API_BASE}/onboarding/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err?.message || "Couldn't read AI provider status.");
      setStatus({ configured_provider: null, has_api_key: false, has_gateway_config: false });
    }
  };

  useEffect(() => {
    load();
    // Refresh when Adam returns from the onboarding flow.
    const handler = () => load();
    window.addEventListener(REOPEN_ONBOARDING_EVENT, handler);
    return () => window.removeEventListener(REOPEN_ONBOARDING_EVENT, handler);
  }, []);

  const providerLabel =
    status?.configured_provider === "anthropic"
      ? "Anthropic"
      : status?.configured_provider === "openai"
      ? "OpenAI"
      : status?.configured_provider === "other"
      ? "Other"
      : "Not configured";

  const connected = !!(status?.has_api_key && status?.configured_provider === "anthropic");
  const model = connected ? "claude-sonnet-4-6" : "—";

  const reconfigure = () => {
    window.dispatchEvent(new CustomEvent(REOPEN_ONBOARDING_EVENT));
  };

  return (
    <div className="px-3 pt-3">
      <div
        style={{
          padding: 12,
          border: "1px solid var(--border)",
          borderRadius: 10,
          background: "var(--bg-elev)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-faint)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          AI provider
        </div>
        <div className="flex items-center gap-2" style={{ marginBottom: 2 }}>
          <Icon.Brain className="lucide-sm" style={{ color: connected ? "var(--green)" : "var(--fg-faint)" }} />
          <span style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)" }}>{providerLabel}</span>
          {connected && <span className="green-dot" style={{ marginLeft: "auto" }} />}
        </div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 10 }}>
          Model: <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{model}</span>
        </div>
        {error && (
          <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>{error}</div>
        )}
        <button
          type="button"
          onClick={reconfigure}
          className="btn-secondary"
          style={{
            width: "100%",
            padding: "6px 10px",
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {connected ? "Reconfigure" : "Set up"}
        </button>
      </div>
    </div>
  );
}

// --- Left rail (grouped) --------------------------------------------------
function ToolRail({ tools, connectedIds, activeId, onSelect, loading }) {
  const connected = tools.filter((t) => connectedIds.has(t.id));
  const ready     = tools.filter((t) => t.status === "ready" && !connectedIds.has(t.id));
  const coming    = tools.filter((t) => t.status === "coming_soon");

  const Row = ({ t }) => {
    const IconCmp = Icon[t.icon] || Icon.Plug;
    const isActive = activeId === t.id;
    const isConnected = connectedIds.has(t.id);
    return (
      <button
        key={t.id}
        onClick={() => onSelect(t.id)}
        className={"tab-row " + (isActive ? "active" : "")}
        style={{ textAlign: "left" }}
        title={t.description}
      >
        <IconCmp className="lucide-sm" />
        <span className="flex-1 truncate">{t.name}</span>
        {isConnected && (
          <span className="flex items-center gap-1" style={{ fontSize: 11, color: "var(--green)" }}>
            <span className="green-dot" />
          </span>
        )}
        {!isConnected && t.status === "coming_soon" && (
          <span style={{ fontSize: 11, color: "var(--fg-faint)" }}>Soon</span>
        )}
      </button>
    );
  };

  const Section = ({ label, count }) => (
    <div
      className="px-3 pt-4 pb-1"
      style={{
        fontSize: 11,
        color: "var(--fg-faint)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {label} <span style={{ color: "var(--fg-faint)", opacity: 0.7 }}>({count})</span>
    </div>
  );

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{ width: 240, borderRight: "1px solid var(--border)", background: "var(--bg)" }}
    >
      <div className="flex-1 overflow-y-auto pb-3 flex flex-col">
        <AiProviderCard />
        {connected.length > 0 && (
          <>
            <Section label="Connected" count={connected.length} />
            <div className="px-2 flex flex-col gap-1">
              {connected.map((t) => <Row key={t.id} t={t} />)}
            </div>
          </>
        )}
        <Section label="Ready to connect" count={ready.length} />
        <div className="px-2 flex flex-col gap-1">
          {loading && ready.length === 0 && (
            <div className="px-2 py-2" style={{ fontSize: 12, color: "var(--fg-faint)" }}>Loading…</div>
          )}
          {ready.map((t) => <Row key={t.id} t={t} />)}
        </div>
        <Section label="Coming soon" count={coming.length} />
        <div className="px-2 flex flex-col gap-1 pb-3">
          {coming.map((t) => <Row key={t.id} t={t} />)}
        </div>
      </div>
    </div>
  );
}

// --- Root component -------------------------------------------------------
function Connections() {
  const [connectedIds, setConnectedIds] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState(null);

  const readyTools = useMemo(() => TOOLS.filter((t) => t.status === "ready"), []);

  const reload = async () => {
    try {
      const results = await Promise.all(
        readyTools.map((t) =>
          fetch(`${API_BASE}/integrations/${t.id}/status`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
            .then((data) => ({ id: t.id, connected: !!data?.connected }))
        )
      );
      const next = new Set();
      for (const r of results) if (r.connected) next.add(r.id);
      setConnectedIds(next);
    } catch {
      setConnectedIds(new Set());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const activeTool = activeId ? toolById(activeId) : null;

  const connectedCount  = connectedIds.size;
  const readyCount      = TOOLS.filter((t) => t.status === "ready" && !connectedIds.has(t.id)).length;
  const comingSoonCount = TOOLS.filter((t) => t.status === "coming_soon").length;

  return (
    <div className="flex-1 flex min-h-0">
      <ToolRail
        tools={TOOLS}
        connectedIds={connectedIds}
        activeId={activeId}
        onSelect={setActiveId}
        loading={loading}
      />
      {activeTool ? (
        <ToolPanel tool={activeTool} onIntegrationChanged={reload} />
      ) : (
        <Welcome
          connectedCount={connectedCount}
          readyCount={readyCount}
          comingSoonCount={comingSoonCount}
        />
      )}
    </div>
  );
}

export default Connections;
