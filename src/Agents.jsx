import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// ---------------------------------------------------------------------------
// Agents tab — list + conversational creator + edit/delete.
//
// Two-pane layout:
//   - Left rail: "Built-in" + "Custom" + "+ Create new agent" button.
//   - Right pane: the active view (welcome / detail / creator wizard).
//
// The creator wizard is a chat-style state machine. Each step renders the
// previous Q/A turns above and the active prompt below — so the interaction
// reads like a conversation with Jackson rather than a multi-page form.
//
// State machine (see `STEPS` below): name → soul → skills → tools → model →
// confirm → creating → done. Edits use the same flow, pre-filled with the
// existing agent's values, and PUT instead of POST on submit.
// ---------------------------------------------------------------------------

const STEPS = ["NAME", "SOUL", "SKILLS", "TOOLS", "MODEL", "CONFIRM", "CREATING", "DONE"];

const STEP_PROMPTS = {
  NAME:    "What should we call this agent?",
  SOUL:    "Tell me about their personality and approach. What kind of work do they do best?",
  SKILLS:  "What specific things should they be able to do? List a few skills, one per line or comma-separated.",
  TOOLS:   "Which tools should this agent be able to use? Pick any that apply.",
  MODEL:   "Which model should power this agent?",
};

const STEP_LABELS = {
  NAME: "Name", SOUL: "Personality", SKILLS: "Skills",
  TOOLS: "Tools", MODEL: "Model", CONFIRM: "Confirm",
};

function emptyDraft() {
  return { name: "", soul: "", skills: [], tools: [], model: "" };
}

export default function Agents({ onOpenChat }) {
  const [tools, setTools] = useState([]);
  const [models, setModels] = useState([]);
  const [defaultModel, setDefaultModel] = useState("sonnet-4-6");
  const [list, setList] = useState({ builtin: [], custom: [] });
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState({ kind: "welcome" });

  const reload = async () => {
    setLoading(true);
    try {
      const [toolsRes, modelsRes, listRes] = await Promise.all([
        fetch(`${API_BASE}/agents/tools`).then((r) => r.json()),
        fetch(`${API_BASE}/agents/models`).then((r) => r.json()),
        fetch(`${API_BASE}/agents/list`).then((r) => r.json()),
      ]);
      setTools(toolsRes.tools || []);
      setModels(modelsRes.models || []);
      setDefaultModel(modelsRes.default || "sonnet-4-6");
      setList(listRes || { builtin: [], custom: [] });
    } catch {
      /* leave whatever we had — don't blank the UI on a transient backend hiccup */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const startCreate = () => {
    setActiveView({ kind: "create", draft: emptyDraft(), step: "NAME", error: "" });
  };

  const startEdit = async (slug) => {
    try {
      const r = await fetch(`${API_BASE}/agents/${encodeURIComponent(slug)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const a = await r.json();
      setActiveView({
        kind: "edit",
        slug,
        draft: {
          name: a.name || "",
          soul: a.soul || "",
          skills: Array.isArray(a.skills) ? a.skills : [],
          tools: Array.isArray(a.tools) ? a.tools : [],
          model: a.model || defaultModel,
        },
        step: "NAME",
        error: "",
      });
    } catch (err) {
      setActiveView({ kind: "error", message: err?.message || "Couldn't load agent." });
    }
  };

  const showDetail = (slug) => setActiveView({ kind: "detail", slug });

  return (
    <div className="flex-1 flex min-h-0">
      <AgentRail
        list={list}
        loading={loading}
        activeSlug={activeView.kind === "detail" || activeView.kind === "edit" ? activeView.slug : null}
        onSelectAgent={showDetail}
        onCreate={startCreate}
      />
      <div className="flex-1 flex flex-col min-w-0" style={{ background: "var(--bg)" }}>
        {activeView.kind === "welcome" && (
          <Welcome
            customCount={list.custom.length}
            onCreate={startCreate}
          />
        )}
        {activeView.kind === "detail" && (
          <DetailView
            slug={activeView.slug}
            onBack={() => setActiveView({ kind: "welcome" })}
            onEdit={() => startEdit(activeView.slug)}
            onOpenChat={onOpenChat}
            onDeleted={async () => {
              await reload();
              setActiveView({ kind: "welcome" });
            }}
          />
        )}
        {(activeView.kind === "create" || activeView.kind === "edit") && (
          <Creator
            mode={activeView.kind}
            slug={activeView.slug}
            draft={activeView.draft}
            step={activeView.step}
            error={activeView.error}
            tools={tools}
            models={models}
            defaultModel={defaultModel}
            setDraft={(updater) =>
              setActiveView((prev) => ({ ...prev, draft: typeof updater === "function" ? updater(prev.draft) : updater }))
            }
            setStep={(step) => setActiveView((prev) => ({ ...prev, step, error: "" }))}
            setError={(error) => setActiveView((prev) => ({ ...prev, error }))}
            onCancel={() => setActiveView({ kind: "welcome" })}
            onComplete={async (slug) => {
              await reload();
              setActiveView({ kind: "detail", slug });
            }}
            onCreateAnother={() => {
              setActiveView({ kind: "create", draft: emptyDraft(), step: "NAME", error: "" });
            }}
          />
        )}
        {activeView.kind === "error" && (
          <div className="flex-1 flex items-center justify-center px-6">
            <div style={{ fontSize: 14, color: "var(--danger)" }}>{activeView.message}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Left rail --------------------------------------------------------------

function AgentRail({ list, loading, activeSlug, onSelectAgent, onCreate }) {
  const Section = ({ label, count }) => (
    <div
      className="px-3 pt-4 pb-1"
      style={{ fontSize: 11, color: "var(--fg-faint)", letterSpacing: "0.04em", textTransform: "uppercase" }}
    >
      {label} <span style={{ opacity: 0.7 }}>({count})</span>
    </div>
  );

  const Row = ({ a }) => {
    const isActive = activeSlug === a.slug;
    const initial = (a.name || a.slug || "?").charAt(0).toUpperCase();
    return (
      <button
        key={a.slug}
        onClick={() => onSelectAgent(a.slug)}
        className={"tab-row " + (isActive ? "active" : "")}
        style={{ textAlign: "left" }}
        title={a.description || a.soul?.slice(0, 80) || a.name}
      >
        <span
          aria-hidden
          style={{
            width: 22, height: 22, borderRadius: 6,
            background: a.builtin ? "var(--accent-soft)" : "var(--bg-elev)",
            border: "1px solid var(--border)",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 600,
            color: a.builtin ? "var(--accent)" : "var(--fg)",
            flexShrink: 0,
          }}
        >
          {initial}
        </span>
        <span className="flex-1 truncate">{a.name || a.slug}</span>
      </button>
    );
  };

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{ width: 240, borderRight: "1px solid var(--border)", background: "var(--bg)" }}
    >
      <div className="flex-1 overflow-y-auto pb-3 flex flex-col">
        <Section label="Built-in" count={list.builtin?.length || 0} />
        <div className="px-2 flex flex-col gap-1">
          {(list.builtin || []).map((a) => <Row key={a.slug} a={a} />)}
        </div>

        <Section label="Custom" count={list.custom?.length || 0} />
        <div className="px-2 flex flex-col gap-1">
          {loading && (list.custom?.length || 0) === 0 && (
            <div className="px-2 py-2" style={{ fontSize: 12, color: "var(--fg-faint)" }}>Loading…</div>
          )}
          {!loading && (list.custom?.length || 0) === 0 && (
            <div className="px-2 py-2" style={{ fontSize: 12, color: "var(--fg-faint)" }}>
              None yet.
            </div>
          )}
          {(list.custom || []).map((a) => <Row key={a.slug} a={a} />)}
        </div>

        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={onCreate}
            className="btn-primary"
            style={{
              width: "100%", padding: "8px 10px", fontSize: 13,
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}
          >
            <Icon.Plus className="lucide-xs" />
            Create new agent
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Welcome ---------------------------------------------------------------

function Welcome({ customCount, onCreate }) {
  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="text-center" style={{ maxWidth: 520 }}>
        <h2 style={{ fontSize: 22, fontWeight: 500, margin: "0 0 10px", color: "var(--fg)" }}>
          Your agents
        </h2>
        <p style={{ fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.6, margin: "0 0 20px" }}>
          Built-in assistants and custom agents you've created. Pick one from the left,
          or build a new one tailored to a specific kind of work.
        </p>
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 14 }}>
          {customCount === 0
            ? "You haven't created any custom agents yet."
            : `${customCount} custom agent${customCount === 1 ? "" : "s"} ready.`}
        </div>
        <button type="button" onClick={onCreate} className="btn-primary" style={{ padding: "8px 16px", fontSize: 14 }}>
          + Create new agent
        </button>
      </div>
    </div>
  );
}

// --- Detail view -----------------------------------------------------------

function DetailView({ slug, onBack, onEdit, onOpenChat, onDeleted }) {
  const [agent, setAgent] = useState(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAgent(null); setError(""); setConfirmDelete(false);
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/agents/${encodeURIComponent(slug)}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setAgent(data);
      } catch (err) {
        if (!cancelled) setError(err?.message || "Couldn't load agent.");
      }
    })();
    return () => { cancelled = true; };
  }, [slug]);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE}/agents/${encodeURIComponent(slug)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onDeleted?.();
    } catch (err) {
      setError(err?.message || "Couldn't delete.");
      setBusy(false);
    }
  };

  if (error) return <div className="flex-1 flex items-center justify-center" style={{ fontSize: 14, color: "var(--danger)" }}>{error}</div>;
  if (!agent) return <div className="flex-1 flex items-center justify-center" style={{ fontSize: 13, color: "var(--fg-faint)" }}>Loading…</div>;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-6 py-6" style={{ maxWidth: 760 }}>
        <button onClick={onBack} className="btn-ghost px-2 py-1" style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 8 }}>
          ← All agents
        </button>

        <div className="flex items-center gap-3" style={{ marginBottom: 6 }}>
          <h2 style={{ fontSize: 22, fontWeight: 500, margin: 0, color: "var(--fg)" }}>{agent.name}</h2>
          {agent.builtin && (
            <span style={pillStyle()}>Built-in</span>
          )}
        </div>
        <div style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 18 }}>
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{agent.slug}</span>
          {agent.model && <> · {agent.model}</>}
          {agent.created_at && <> · created {agent.created_at}</>}
        </div>

        <div className="flex gap-2 flex-wrap" style={{ marginBottom: 22 }}>
          <button
            type="button"
            onClick={() => onOpenChat?.(agent.slug)}
            className="btn-primary px-3 py-1.5"
            style={{ fontSize: 13 }}
          >
            Open chat
          </button>
          {!agent.builtin && (
            <>
              <button type="button" onClick={onEdit} className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }}>
                Edit
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="btn-ghost px-3 py-1.5"
                style={{ fontSize: 13, color: "var(--danger)" }}
              >
                {confirmDelete ? (busy ? "Deleting…" : "Confirm delete?") : "Delete"}
              </button>
              {confirmDelete && !busy && (
                <button type="button" onClick={() => setConfirmDelete(false)} className="btn-ghost px-3 py-1.5" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
                  Cancel
                </button>
              )}
            </>
          )}
        </div>

        {!agent.builtin && (
          <Section label="Personality">
            <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {agent.soul || "—"}
            </div>
          </Section>
        )}
        {!agent.builtin && (agent.skills?.length || 0) > 0 && (
          <Section label="Skills">
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, color: "var(--fg)", lineHeight: 1.6 }}>
              {agent.skills.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </Section>
        )}
        {!agent.builtin && (agent.tools?.length || 0) > 0 && (
          <Section label="Tools">
            <div className="flex flex-wrap" style={{ gap: 6 }}>
              {agent.tools.map((t) => <span key={t} style={pillStyle()}>{t}</span>)}
            </div>
          </Section>
        )}

        {agent.soul_md && (
          <Section label="SOUL.md">
            <pre style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap",
              background: "var(--bg-elev)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "10px 12px", margin: 0, color: "var(--fg-muted)",
            }}>
              {agent.soul_md}
            </pre>
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, color: "var(--fg-faint)", letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 8 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function pillStyle() {
  return {
    fontSize: 11,
    padding: "2px 8px",
    borderRadius: 999,
    background: "var(--bg-elev)",
    border: "1px solid var(--border)",
    color: "var(--fg-muted)",
    letterSpacing: "0.02em",
  };
}

// --- Creator wizard --------------------------------------------------------

function Creator({
  mode, slug, draft, step, error, tools, models, defaultModel,
  setDraft, setStep, setError,
  onCancel, onComplete, onCreateAnother,
}) {
  const turnsRef = useRef(null);
  useEffect(() => {
    if (turnsRef.current) turnsRef.current.scrollTop = turnsRef.current.scrollHeight;
  }, [step]);

  // The conversation transcript above the active prompt. Each step that's
  // already past becomes a Q/A pair; the active step renders its own input.
  const turns = useMemo(() => {
    const t = [];
    const passed = STEPS.slice(0, STEPS.indexOf(step));
    for (const k of passed) {
      if (!STEP_PROMPTS[k]) continue; // skip CONFIRM/CREATING/DONE which have no prompt label
      const value = renderDraftValue(k, draft, tools, models);
      t.push({ q: STEP_PROMPTS[k], a: value, step: k });
    }
    return t;
  }, [step, draft, tools, models]);

  const goBack = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const advance = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  };

  const submit = async () => {
    setStep("CREATING");
    setError("");
    try {
      const url = mode === "edit"
        ? `${API_BASE}/agents/${encodeURIComponent(slug)}`
        : `${API_BASE}/agents/create`;
      const method = mode === "edit" ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          soul: draft.soul,
          skills: draft.skills,
          tools: draft.tools,
          model: draft.model || defaultModel,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.detail || `HTTP ${r.status}`);
      setStep("DONE");
      // Stash the resulting slug so the Done step can deep-link.
      setDraft((prev) => ({ ...prev, _resultSlug: data.slug || slug }));
    } catch (err) {
      setError(err?.message || "Could not save agent.");
      setStep("CONFIRM");
    }
  };

  const headerLabel = mode === "edit" ? `Editing ${draft.name || slug}` : "Create a new agent";

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div
        className="flex items-center justify-between px-6 py-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onCancel} className="btn-ghost p-1.5" title="Back" style={{ color: "var(--fg-muted)" }}>
            <Icon.ArrowLeft className="lucide-sm" />
          </button>
          <div style={{ fontSize: 15, fontWeight: 500, color: "var(--fg)" }}>{headerLabel}</div>
        </div>
        <StepIndicator step={step} />
      </div>

      <div ref={turnsRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto px-6 py-5" style={{ maxWidth: 720 }}>
          {turns.map((t, i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 6 }}>{t.q}</div>
              <div
                onClick={() => setStep(t.step)}
                role="button"
                tabIndex={0}
                style={{
                  fontSize: 14, color: "var(--fg)", lineHeight: 1.55,
                  background: "var(--bg-elev)", border: "1px solid var(--border)",
                  borderRadius: 8, padding: "8px 12px", cursor: "pointer",
                  whiteSpace: "pre-wrap",
                }}
                title="Edit this answer"
              >
                {t.a}
              </div>
            </div>
          ))}

          {/* Active step prompt */}
          {step !== "CREATING" && step !== "DONE" && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 14, color: "var(--fg)", marginBottom: 10, lineHeight: 1.55 }}>
                {STEP_PROMPTS[step] || (step === "CONFIRM" ? "Ready to save?" : "")}
              </div>
              {step === "NAME" && (
                <NameInput
                  value={draft.name}
                  onChange={(name) => setDraft((p) => ({ ...p, name }))}
                  onSubmit={() => {
                    if (!draft.name.trim()) { setError("Name is required."); return; }
                    setError("");
                    advance();
                  }}
                />
              )}
              {step === "SOUL" && (
                <ProseInput
                  value={draft.soul}
                  placeholder="e.g. Calm and methodical. Dives deep into financial filings…"
                  onChange={(soul) => setDraft((p) => ({ ...p, soul }))}
                  onSubmit={() => {
                    if (!draft.soul.trim()) { setError("Tell me a little about how they think."); return; }
                    setError("");
                    advance();
                  }}
                />
              )}
              {step === "SKILLS" && (
                <SkillsInput
                  value={draft.skills}
                  onChange={(skills) => setDraft((p) => ({ ...p, skills }))}
                  onSubmit={() => {
                    setError("");
                    advance();
                  }}
                />
              )}
              {step === "TOOLS" && (
                <ToolsPicker
                  tools={tools}
                  selected={draft.tools}
                  onChange={(toolsSel) => setDraft((p) => ({ ...p, tools: toolsSel }))}
                  onSubmit={() => { setError(""); advance(); }}
                />
              )}
              {step === "MODEL" && (
                <ModelPicker
                  models={models}
                  defaultModel={defaultModel}
                  value={draft.model || defaultModel}
                  onChange={(model) => setDraft((p) => ({ ...p, model }))}
                  onSubmit={() => { setError(""); advance(); }}
                />
              )}
              {step === "CONFIRM" && (
                <ConfirmCard
                  draft={draft}
                  tools={tools}
                  models={models}
                  defaultModel={defaultModel}
                  busy={false}
                  onBack={goBack}
                  onSubmit={submit}
                  submitLabel={mode === "edit" ? "Save changes" : "Create agent"}
                />
              )}
              {error && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>{error}</div>
              )}
            </div>
          )}

          {step === "CREATING" && (
            <div className="flex items-center gap-3" style={{ padding: "20px 0", fontSize: 14 }}>
              <Icon.Loader className="lucide-sm spin" style={{ color: "var(--accent)" }} />
              {mode === "edit" ? `Saving ${draft.name}…` : `Creating ${draft.name || "agent"}…`}
            </div>
          )}

          {step === "DONE" && (
            <DoneCard
              draft={draft}
              mode={mode}
              onView={() => onComplete(draft._resultSlug || slug)}
              onCreateAnother={onCreateAnother}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ step }) {
  const wizardSteps = ["NAME", "SOUL", "SKILLS", "TOOLS", "MODEL", "CONFIRM"];
  const idx = wizardSteps.indexOf(step);
  return (
    <div className="flex items-center gap-2">
      <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        {idx >= 0 ? `Step ${idx + 1} of ${wizardSteps.length}` : step === "DONE" ? "Done" : "Saving…"}
      </span>
      <div className="flex items-center" style={{ gap: 4 }}>
        {wizardSteps.map((_, i) => (
          <div
            key={i}
            style={{
              width: 6, height: 6, borderRadius: 999,
              background: i <= idx ? "var(--accent)" : "var(--border-strong)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function renderDraftValue(stepKey, draft, tools, models) {
  if (stepKey === "NAME")    return draft.name || "—";
  if (stepKey === "SOUL")    return draft.soul || "—";
  if (stepKey === "SKILLS")  {
    if (!(draft.skills?.length)) return "(no skills)";
    return draft.skills.map((s) => `• ${s}`).join("\n");
  }
  if (stepKey === "TOOLS") {
    if (!(draft.tools?.length)) return "(no tools)";
    return draft.tools.join(", ");
  }
  if (stepKey === "MODEL") {
    const m = models.find((x) => x.id === (draft.model || "")) || null;
    return m ? m.label : (draft.model || "default");
  }
  return "";
}

// --- Inputs per step -------------------------------------------------------

function NameInput({ value, onChange, onSubmit }) {
  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        autoFocus
        spellCheck={false}
        placeholder="e.g. Research Analyst"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
        style={inputStyle()}
        maxLength={50}
      />
      <button type="button" onClick={onSubmit} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
        Next
      </button>
    </div>
  );
}

function ProseInput({ value, placeholder, onChange, onSubmit }) {
  return (
    <div>
      <textarea
        value={value}
        autoFocus
        rows={5}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
        }}
        style={{ ...inputStyle(), minHeight: 100, resize: "vertical" }}
      />
      <div className="flex items-center justify-between" style={{ marginTop: 6 }}>
        <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>⌘+Enter to continue</div>
        <button type="button" onClick={onSubmit} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
          Next
        </button>
      </div>
    </div>
  );
}

function SkillsInput({ value, onChange, onSubmit }) {
  // value is a list[str]; render as a single textarea, one skill per line.
  const text = (value || []).join("\n");
  const handleChange = (raw) => {
    const list = raw.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
    onChange(list);
  };
  return (
    <div>
      <textarea
        value={text}
        autoFocus
        rows={5}
        placeholder={"e.g.\nRead 10-K filings\nSummarize earnings calls\nIdentify hidden risks"}
        onChange={(e) => {
          // Don't normalise on every keystroke — preserve trailing newlines so
          // the textarea feels natural. Only normalise on blur/submit.
          const lines = e.target.value.split("\n");
          // Pass through verbatim; we'll trim on submit.
          onChange(lines.map((s) => s.trim()).filter(Boolean));
          // But don't lose the trailing-empty-line state; React re-renders
          // from `value` so the user might lose blank lines. Simpler: just
          // keep filtered list as truth.
        }}
        onBlur={(e) => handleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
        }}
        style={{ ...inputStyle(), minHeight: 110, resize: "vertical" }}
      />
      <div className="flex items-center justify-between" style={{ marginTop: 6 }}>
        <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>One per line — or comma-separated. ⌘+Enter to continue.</div>
        <button type="button" onClick={onSubmit} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
          Next
        </button>
      </div>
    </div>
  );
}

function ToolsPicker({ tools, selected, onChange, onSubmit }) {
  const toggle = (id) => {
    if (selected.includes(id)) {
      onChange(selected.filter((x) => x !== id));
    } else {
      onChange([...selected, id]);
    }
  };
  return (
    <div>
      <div className="flex flex-col" style={{ gap: 8 }}>
        {tools.map((t) => {
          const on = selected.includes(t.id);
          return (
            <label
              key={t.id}
              className="flex items-start gap-3"
              style={{
                padding: "10px 12px",
                border: "1px solid " + (on ? "var(--accent)" : "var(--border)"),
                borderRadius: 8,
                background: on ? "var(--accent-soft)" : "var(--bg-elev)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(t.id)}
                style={{ marginTop: 2 }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{t.id}</div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{t.description}</div>
              </div>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
        <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>
          {selected.length} selected. You can leave this empty if the agent doesn't need external tools.
        </div>
        <button type="button" onClick={onSubmit} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
          Next
        </button>
      </div>
    </div>
  );
}

function ModelPicker({ models, defaultModel, value, onChange, onSubmit }) {
  return (
    <div>
      <select
        value={value || defaultModel}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle(), padding: "8px 10px" }}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <div className="flex items-center justify-end" style={{ marginTop: 10 }}>
        <button type="button" onClick={onSubmit} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
          Next
        </button>
      </div>
    </div>
  );
}

function ConfirmCard({ draft, tools, models, defaultModel, onBack, onSubmit, submitLabel }) {
  const modelLabel = (models.find((m) => m.id === (draft.model || defaultModel)) || {}).label || draft.model || defaultModel;
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-elev)",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)", marginBottom: 12 }}>
        Ready to save {draft.name || "this agent"}? Here's what I have:
      </div>
      <Field label="Name"        value={draft.name || "—"} />
      <Field label="Personality" value={draft.soul || "—"} multiline />
      <Field label="Skills"      value={(draft.skills || []).map((s) => `• ${s}`).join("\n") || "—"} multiline />
      <Field label="Tools"       value={(draft.tools || []).join(", ") || "—"} />
      <Field label="Model"       value={modelLabel} />
      <div className="flex gap-2" style={{ marginTop: 12 }}>
        <button type="button" onClick={onBack}   className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }}>← Back</button>
        <button type="button" onClick={onSubmit} className="btn-primary   px-3 py-1.5" style={{ fontSize: 13 }}>{submitLabel}</button>
      </div>
    </div>
  );
}

function Field({ label, value, multiline }) {
  return (
    <div className="flex" style={{ gap: 14, alignItems: "flex-start", marginBottom: 8 }}>
      <div style={{
        width: 92, fontSize: 11, color: "var(--fg-faint)",
        letterSpacing: "0.04em", textTransform: "uppercase", paddingTop: 2,
      }}>{label}</div>
      <div style={{
        flex: 1, fontSize: 13, color: "var(--fg)",
        whiteSpace: multiline ? "pre-wrap" : "normal", wordBreak: "break-word",
      }}>{value}</div>
    </div>
  );
}

function DoneCard({ draft, mode, onView, onCreateAnother }) {
  const verb = mode === "edit" ? "saved" : "ready";
  return (
    <div
      style={{
        padding: 18,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-elev)",
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
        <Icon.CheckCircle2 className="lucide-sm" style={{ color: "var(--green)" }} />
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--fg)" }}>
          {draft.name} {verb === "ready" ? "is ready" : "saved"}
        </div>
      </div>
      <div style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 14 }}>
        {verb === "ready"
          ? "Find them on your Dashboard alongside Personal and Marketing."
          : "Your changes are live."}
      </div>
      <div className="flex gap-2 flex-wrap">
        <button type="button" onClick={onView} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
          View agent
        </button>
        {mode !== "edit" && (
          <button type="button" onClick={onCreateAnother} className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }}>
            Create another
          </button>
        )}
      </div>
    </div>
  );
}

function inputStyle() {
  return {
    flex: 1,
    width: "100%",
    padding: "8px 10px",
    fontSize: 14,
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    background: "var(--bg)",
    color: "var(--fg)",
    fontFamily: "inherit",
  };
}
