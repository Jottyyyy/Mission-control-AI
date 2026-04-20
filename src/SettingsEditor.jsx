import React, { useState, useEffect, useMemo } from 'react';
import Icon from './icons.jsx';

export const API_BASE = "http://127.0.0.1:8001";

// Cap the width of settings content so it doesn't stretch edge-to-edge on
// 1920px monitors. Inline style (vs Tailwind max-w-*) so the exact pixel value
// lives with the layout decision.
const SECTION_MAX_WIDTH = 1120;

function SectionShell({ children }) {
  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 overflow-y-auto flex-1">
      <div className="mx-auto w-full" style={{ maxWidth: SECTION_MAX_WIDTH }}>
        {children}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Shared bits
// -----------------------------------------------------------------------------

const SAFETY_TEXT =
  "Editing this file changes how your assistant thinks and behaves. Every save creates a backup — use 'Restore previous version' to undo.";

function SafetyBanner() {
  return (
    <div
      className="mb-5 px-4 py-3"
      style={{
        background: "var(--bg-elev)",
        border: "1px solid var(--border)",
        borderLeftWidth: 2,
        borderLeftColor: "var(--accent-line)",
        borderRadius: 8,
        fontSize: 13,
        color: "var(--fg-muted)",
        lineHeight: 1.55,
      }}
    >
      {SAFETY_TEXT}
    </div>
  );
}

function SectionHeading({ title, subtitle }) {
  return (
    <div className="mb-6">
      <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 4 }}>{title}</h2>
      <p style={{ color: "var(--fg-muted)", fontSize: 14, lineHeight: 1.5 }}>{subtitle}</p>
    </div>
  );
}

function formatMtime(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// -----------------------------------------------------------------------------
// MarkdownEditor: load / edit / save / restore a single workspace file.
// -----------------------------------------------------------------------------

export function MarkdownEditor({ path, intro }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [mtime, setMtime] = useState(null);
  const [backups, setBackups] = useState([]);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [saveError, setSaveError] = useState(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const dirty = useMemo(() => draft !== saved, [draft, saved]);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`${API_BASE}/config/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
      }
      const data = await res.json();
      setSaved(data.content || "");
      setDraft(data.content || "");
      setMtime(data.mtime);
      setBackups(data.backups || []);
    } catch (err) {
      setLoadError(err.message || "Could not load the file.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [path]);

  const handleSave = async () => {
    if (!dirty || saveState === "saving") return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch(`${API_BASE}/config/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setSaved(draft);
      setMtime(data.mtime);
      setBackups(data.backups || []);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      setSaveError(err.message || "Save failed.");
      setSaveState("error");
    }
  };

  const handleRevert = () => {
    setDraft(saved);
  };

  const handleRestore = async (backup) => {
    setRestoreOpen(false);
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch(`${API_BASE}/config/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, backup: backup.file }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      // Re-fetch to pick up the restored content.
      await load();
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err) {
      setSaveError(err.message || "Restore failed.");
      setSaveState("error");
    }
  };

  return (
    <div>
      <SafetyBanner />

      {intro && (
        <div style={{ fontSize: 14, color: "var(--fg-muted)", marginBottom: 16, lineHeight: 1.55 }}>
          {intro}
        </div>
      )}

      {/* Meta / actions row */}
      <div
        className="flex items-center flex-wrap gap-3 mb-3"
        style={{ fontSize: 13 }}
      >
        <div style={{ color: "var(--fg-faint)" }}>
          <span>File: </span>
          <span style={{ color: "var(--fg-muted)", fontFamily: "ui-monospace, monospace" }}>{path}</span>
        </div>
        <div style={{ color: "var(--fg-faint)" }}>
          Last saved: <span style={{ color: "var(--fg-muted)" }}>{formatMtime(mtime)}</span>
        </div>
        {dirty && (
          <div style={{ color: "var(--accent)" }}>
            Unsaved changes
          </div>
        )}
        <div className="flex-1" />
        <div className="relative">
          <button
            className="btn-secondary px-3 py-1.5"
            style={{ fontSize: 13 }}
            onClick={() => setRestoreOpen((o) => !o)}
            disabled={backups.length === 0}
            title={backups.length === 0 ? "No backups yet" : "Restore a previous version"}
          >
            <span className="flex items-center gap-1.5">
              <Icon.RefreshCw className="lucide-xs" />
              Restore previous
            </span>
          </button>
          {restoreOpen && backups.length > 0 && (
            <div
              className="absolute right-0 mt-1 card slide-in-top"
              style={{ minWidth: 240, zIndex: 30, maxHeight: 300, overflowY: "auto" }}
              onMouseLeave={() => setRestoreOpen(false)}
            >
              {backups.map((b) => (
                <button
                  key={b.file}
                  className="w-full text-left px-3 py-2"
                  style={{ fontSize: 13, color: "var(--fg)", borderTop: "1px solid var(--border)" }}
                  onClick={() => handleRestore(b)}
                >
                  <div>{b.timestamp}</div>
                  <div style={{ fontSize: 11, color: "var(--fg-faint)", fontFamily: "ui-monospace, monospace" }}>
                    {b.file}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="btn-secondary px-3 py-1.5"
          style={{ fontSize: 13 }}
          onClick={handleRevert}
          disabled={!dirty || saveState === "saving"}
          title="Discard unsaved changes"
        >
          Revert
        </button>
        <button
          className="btn-primary px-3 py-1.5"
          style={{ fontSize: 13 }}
          onClick={handleSave}
          disabled={!dirty || saveState === "saving"}
          title={dirty ? "Save changes" : "Nothing to save"}
        >
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Save"}
        </button>
      </div>

      {/* Status strip for load / save errors */}
      {(loadError || saveError) && (
        <div
          className="mb-3 px-3 py-2"
          style={{
            fontSize: 13,
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            color: "var(--fg-muted)",
            background: "var(--bg-elev)",
          }}
        >
          {loadError || saveError}
        </div>
      )}

      {/* Editor */}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={loading || saveState === "saving"}
        placeholder={loading ? "Loading…" : "Markdown content"}
        spellCheck={false}
        style={{
          width: "100%",
          minHeight: 480,
          padding: 16,
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 13,
          lineHeight: 1.6,
          background: "var(--bg-elev)",
          color: "var(--fg)",
          resize: "vertical",
          outline: "none",
        }}
      />
      <div className="mt-2" style={{ fontSize: 11, color: "var(--fg-faint)" }}>
        {draft.length} characters · plain Markdown · saves create a backup automatically.
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Section wrappers for the sidebar tabs
// -----------------------------------------------------------------------------

function SubTabs({ options, value, onChange }) {
  return (
    <div className="flex items-center gap-1 mb-5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="step-pill"
            style={
              active
                ? { background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid transparent", cursor: "pointer" }
                : { background: "transparent", color: "var(--fg-muted)", border: "1px solid var(--border-strong)", cursor: "pointer" }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SoulSection() {
  const [tab, setTab] = useState("main");
  const pathFor = {
    main: "SOUL.md",
    personal: "agents/personal/SOUL.md",
    marketing: "agents/marketing/SOUL.md",
  };
  return (
    <SectionShell>
      <SectionHeading
        title="Soul"
        subtitle="How your assistant sees itself. One voice for the main agent, plus a softer edit for each specialist."
      />
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "main",      label: "Main" },
          { value: "personal",  label: "Personal" },
          { value: "marketing", label: "Marketing" },
        ]}
      />
      <MarkdownEditor path={pathFor[tab]} />
    </SectionShell>
  );
}

export function RulesSection() {
  const [tab, setTab] = useState("jsp");
  const pathFor = {
    jsp:   "JSP-CONTEXT.md",
    rules: "AGENTS.md",
  };
  return (
    <SectionShell>
      <SectionHeading
        title="Rules"
        subtitle="Firm operating rules and the main agent's routing playbook."
      />
      <SubTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "jsp",   label: "JSP Context" },
          { value: "rules", label: "Agent Rules" },
        ]}
      />
      <MarkdownEditor path={pathFor[tab]} />
    </SectionShell>
  );
}

export function AboutYouSection() {
  return (
    <SectionShell>
      <SectionHeading
        title="About you"
        subtitle="This is how I know you. Keep it current so I serve you well."
      />
      <MarkdownEditor
        path="USER.md"
        intro="Name, preferences, recurring commitments, colleagues, anything that shapes how I act on your behalf."
      />
    </SectionShell>
  );
}

// -----------------------------------------------------------------------------
// Workspace: read-only tree + preview pane
// -----------------------------------------------------------------------------

function TreeNode({ node, onSelect, selectedPath, depth }) {
  const [open, setOpen] = useState(depth < 1);
  if (node.type === "dir") {
    return (
      <div>
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-1.5 px-1 py-1"
          style={{
            fontSize: 13,
            color: "var(--fg-muted)",
            textAlign: "left",
          }}
        >
          {open ? <Icon.ChevronDown className="lucide-xs" /> : <Icon.ChevronRight className="lucide-xs" />}
          <Icon.Folder className="lucide-xs" />
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <div style={{ paddingLeft: 14, borderLeft: "1px solid var(--border)", marginLeft: 6 }}>
            {(node.children || []).map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                onSelect={onSelect}
                selectedPath={selectedPath}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  const active = selectedPath === node.path;
  return (
    <button
      onClick={() => onSelect(node)}
      className="w-full flex items-center gap-1.5 px-1 py-1"
      style={{
        fontSize: 13,
        color: active ? "var(--accent)" : "var(--fg)",
        background: active ? "var(--accent-soft)" : "transparent",
        borderRadius: 4,
        textAlign: "left",
      }}
    >
      <Icon.FileText className="lucide-xs" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function WorkspaceSection() {
  const [tree, setTree] = useState([]);
  const [treeError, setTreeError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState({ loading: false, error: null, mtime: null, size: 0 });

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/workspace/tree`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setTree(data.tree || []);
      } catch (err) {
        setTreeError(err.message || "Could not load the workspace tree.");
      }
    })();
  }, []);

  const handleSelect = async (node) => {
    setSelected(node.path);
    setContent("");
    setPreview({ loading: true, error: null, mtime: null, size: node.size });
    try {
      const res = await fetch(`${API_BASE}/workspace/file?path=${encodeURIComponent(node.path)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setContent(data.content);
      setPreview({ loading: false, error: null, mtime: data.mtime, size: data.size });
    } catch (err) {
      setPreview({ loading: false, error: err.message || "Could not load file.", mtime: null, size: 0 });
    }
  };

  return (
    <SectionShell>
      <SectionHeading
        title="Workspace"
        subtitle="Read-only view of your OpenClaw workspace. Use Soul, Rules, and About you to edit the files that shape the assistant."
      />
      <div className="flex flex-wrap gap-4 lg:gap-6" style={{ minHeight: 520 }}>
        {/* Tree — sticks at 280px on ≥1024px; wraps to full width below that. */}
        <div
          className="p-3 w-full lg:w-[280px] lg:flex-shrink-0"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-elev)",
            overflowY: "auto",
            maxHeight: 600,
          }}
        >
          {treeError ? (
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>{treeError}</div>
          ) : tree.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>Loading workspace…</div>
          ) : (
            tree.map((n) => (
              <TreeNode key={n.path} node={n} onSelect={handleSelect} selectedPath={selected} depth={0} />
            ))
          )}
        </div>

        {/* Preview — min-w-0 lets flex shrink it below its intrinsic content width. */}
        <div
          className="flex-1 p-4 min-w-0"
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-elev)",
            overflow: "hidden",
            minWidth: 0,
          }}
        >
          {!selected && (
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              Select a file to preview. Preview is read-only.
            </div>
          )}
          {selected && preview.loading && (
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>Loading…</div>
          )}
          {selected && preview.error && (
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>{preview.error}</div>
          )}
          {selected && !preview.loading && !preview.error && (
            <>
              <div
                className="flex items-center justify-between gap-3 mb-3 flex-wrap"
                style={{ fontSize: 12, color: "var(--fg-faint)" }}
              >
                <span style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{selected}</span>
                <span style={{ flexShrink: 0 }}>
                  {preview.size} bytes · last modified {formatMtime(preview.mtime)}
                </span>
              </div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 13,
                  lineHeight: 1.6,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  color: "var(--fg)",
                  margin: 0,
                  maxHeight: 540,
                  overflow: "auto",
                }}
              >
                {content}
              </pre>
            </>
          )}
        </div>
      </div>
    </SectionShell>
  );
}

// -----------------------------------------------------------------------------
// Custom skill modal (METHOD 1 — form)
// -----------------------------------------------------------------------------

export function NewSkillModal({ open, onClose, onCreated, onDescribeInChat }) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [group, setGroup] = useState("personal");
  const [purpose, setPurpose] = useState("");
  const [inputs, setInputs] = useState("");
  const [outputs, setOutputs] = useState("");
  const [submitState, setSubmitState] = useState("idle"); // idle | saving | error
  const [errorText, setErrorText] = useState(null);

  // Escape to close + body-scroll lock while the modal is open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const nameOk = /^[a-z][a-z0-9\-]{1,39}$/.test(name);
  const canSubmit = nameOk && displayName.trim() && description.trim() && purpose.trim();

  const handleCreate = async () => {
    if (!canSubmit || submitState === "saving") return;
    setSubmitState("saving");
    setErrorText(null);
    try {
      const res = await fetch(`${API_BASE}/skills/custom`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          display_name: displayName,
          description,
          group,
          purpose,
          inputs,
          outputs,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      onCreated && onCreated(name);
      onClose();
    } catch (err) {
      setErrorText(err.message || "Could not create the skill.");
      setSubmitState("error");
    }
  };

  const Field = ({ label, children, hint }) => (
    <div className="mb-3">
      <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 4 }}>{label}</div>
      {children}
      {hint && (
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );

  const inputStyle = {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg)",
    color: "var(--fg)",
    fontFamily: "inherit",
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{
        background: "rgba(0,0,0,0.35)",
        zIndex: 50,
        padding: 16,
      }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="slide-in-top w-full"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 560,
          maxHeight: "85vh",
          background: "var(--bg)",
          border: "1px solid var(--border-strong)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}
        >
          <div style={{ fontSize: 15, fontWeight: 500 }}>New skill</div>
          <button className="btn-ghost p-1" onClick={onClose} title="Close (Esc)">
            <Icon.X className="lucide-sm" />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto" style={{ flex: 1 }}>
          <Field label="Name" hint="Folder-safe: lowercase letters, digits, hyphens. e.g. weekly-review">
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="weekly-review"
              style={inputStyle}
            />
          </Field>
          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Weekly Review"
              style={inputStyle}
            />
          </Field>
          <Field label="Description" hint="One short line — shown in the skill list.">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="A quick Friday readout of everything that moved this week."
              style={inputStyle}
            />
          </Field>
          <Field label="Group">
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              style={inputStyle}
            >
              <option value="personal">Personal</option>
              <option value="marketing">Marketing</option>
            </select>
          </Field>
          <Field label="Purpose" hint="A paragraph describing what it does and when it runs.">
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={4}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>
          <Field label="Inputs">
            <textarea
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
              rows={3}
              placeholder="What the skill needs to run."
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>
          <Field label="Outputs">
            <textarea
              value={outputs}
              onChange={(e) => setOutputs(e.target.value)}
              rows={3}
              placeholder="What the skill returns."
              style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }}
            />
          </Field>

          {errorText && (
            <div
              className="px-3 py-2"
              style={{
                fontSize: 13,
                border: "1px solid var(--border-strong)",
                borderRadius: 6,
                color: "var(--fg-muted)",
                background: "var(--bg-elev)",
              }}
            >
              {errorText}
            </div>
          )}
        </div>

        <div
          className="px-5 py-3 flex items-center gap-2 flex-wrap"
          style={{ borderTop: "1px solid var(--border)", flexShrink: 0 }}
        >
          {onDescribeInChat && (
            <button
              className="btn-ghost px-3 py-1.5"
              style={{ fontSize: 13 }}
              onClick={() => { onClose(); onDescribeInChat(); }}
              title="Tell your assistant about it instead"
            >
              <span className="flex items-center gap-1.5">
                <Icon.Sparkles className="lucide-xs" />
                Describe to my assistant
              </span>
            </button>
          )}
          <div className="flex-1" />
          <button className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary px-3 py-1.5"
            style={{ fontSize: 13 }}
            onClick={handleCreate}
            disabled={!canSubmit || submitState === "saving"}
          >
            {submitState === "saving" ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
