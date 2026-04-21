import React, { useState, useEffect, useCallback } from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';

const API_BASE = "http://127.0.0.1:8001";

// Bucket label for a conversation's updated_at relative to "now".
// Returns "today" | "yesterday" | "week" | "earlier".
function bucketFor(updatedAt) {
  if (!updatedAt) return "earlier";
  // SQLite's CURRENT_TIMESTAMP is UTC in the form "YYYY-MM-DD HH:MM:SS".
  // Normalise it to an ISO Z-string so Date.parse doesn't guess the zone.
  const iso = updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "earlier";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 3600 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 3600 * 1000;
  if (t >= startOfToday) return "today";
  if (t >= startOfYesterday) return "yesterday";
  if (t >= startOfWeek) return "week";
  return "earlier";
}

function relativeLabel(updatedAt) {
  if (!updatedAt) return "";
  const iso = updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diffMs = Date.now() - t;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Sidebar({
  assistantKey,
  activeConversationUuid,
  onSelectConversation,
  onNewConvo,
  onOpenSettings,
  onBackToDashboard,
}) {
  const a = Data.assistants[assistantKey];
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/conversations?mode=${encodeURIComponent(assistantKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.conversations || []);
    } catch (e) {
      setItems([]);
      setError("Can't reach the local service.");
    } finally {
      setLoading(false);
    }
  }, [assistantKey]);

  // Reload when assistant changes, when the active conversation changes (a new
  // send promotes a conversation to "today"), and on a loose interval.
  useEffect(() => { reload(); }, [reload, activeConversationUuid]);

  const handleDelete = async (uuid, e) => {
    e.stopPropagation();
    if (confirmDeleteId !== uuid) {
      setConfirmDeleteId(uuid);
      return;
    }
    setConfirmDeleteId(null);
    try {
      await fetch(`${API_BASE}/conversations/${uuid}`, { method: "DELETE" });
    } catch (_) { /* ignore — reload will reflect state */ }
    if (activeConversationUuid === uuid) {
      onSelectConversation(null);
    }
    reload();
  };

  const groups = { today: [], yesterday: [], week: [], earlier: [] };
  for (const c of items) groups[bucketFor(c.updated_at)].push(c);

  const Group = ({ title, entries }) => (
    <div className="mb-4">
      <div className="px-2 pb-1" style={{ fontSize: 12, color: "var(--fg-faint)", letterSpacing: "0.02em" }}>
        {title}
      </div>
      <div className="flex flex-col gap-0.5">
        {entries.map((c) => {
          const isActive = activeConversationUuid === c.uuid;
          const isConfirming = confirmDeleteId === c.uuid;
          return (
            <div key={c.uuid} className="relative group">
              <button
                onClick={() => onSelectConversation(c.uuid)}
                className={"convo-row text-left w-full px-2 py-1.5 flex items-center gap-2 " + (isActive ? "active" : "")}
                style={{
                  fontSize: 14,
                  color: isActive ? "var(--fg)" : "var(--fg-muted)",
                  paddingRight: 28,
                }}
                title={c.title || "Untitled"}
              >
                <span className="truncate flex-1">{c.title || "Untitled"}</span>
                <span style={{ fontSize: 11, color: "var(--fg-faint)", flexShrink: 0 }}>
                  {relativeLabel(c.updated_at)}
                </span>
              </button>
              <button
                onClick={(e) => handleDelete(c.uuid, e)}
                onMouseLeave={() => { if (isConfirming) setConfirmDeleteId(null); }}
                className="absolute btn-ghost"
                style={{
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  padding: 2,
                  opacity: isConfirming ? 1 : 0,
                  color: isConfirming ? "var(--danger)" : "var(--fg-faint)",
                  transition: "opacity 120ms",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; }}
                title={isConfirming ? "Click again to confirm" : "Delete"}
              >
                <Icon.X className="lucide-xs" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const totalCount = items.length;

  return (
    <aside
      className="h-full flex flex-col"
      style={{
        width: 240,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onBackToDashboard}
          className="btn-ghost w-full flex items-center gap-2 px-2 py-1.5"
          style={{ fontSize: 13, color: "var(--fg-muted)" }}
        >
          <Icon.ArrowLeft className="lucide-sm" />
          <span>Dashboard</span>
        </button>
      </div>

      <div className="px-5 pt-1 pb-3">
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 2 }}>Working with</div>
        <div className="flex items-center gap-2">
          <div className="logo-square" style={{ width: 22, height: 22, color: "var(--accent)" }}>
            {React.createElement(Icon[a.icon], { className: "lucide-xs" })}
          </div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div>
        </div>
      </div>

      <div className="px-3 pb-2">
        <button
          onClick={onNewConvo}
          className="btn-ghost w-full flex items-center justify-between px-2 py-1.5 text-[14px]"
          style={{ color: "var(--fg)" }}
        >
          <span className="flex items-center gap-2">
            <Icon.Plus className="lucide-sm" />
            New conversation
          </span>
          <span style={{ fontSize: 11, color: "var(--fg-faint)" }}>⌘N</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pt-2">
        {totalCount === 0 && !loading && !error && (
          <div className="px-2 py-6" style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Your recent conversations will appear here.
          </div>
        )}
        {loading && totalCount === 0 && (
          <div className="px-2 py-6" style={{ fontSize: 13, color: "var(--fg-faint)" }}>
            Loading…
          </div>
        )}
        {error && (
          <div className="px-2 py-6" style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            {error}
          </div>
        )}
        {groups.today.length > 0 && <Group title="Today" entries={groups.today} />}
        {groups.yesterday.length > 0 && <Group title="Yesterday" entries={groups.yesterday} />}
        {groups.week.length > 0 && <Group title="This week" entries={groups.week} />}
        {groups.earlier.length > 0 && <Group title="Earlier" entries={groups.earlier} />}
      </div>

      <div
        className="px-3 py-3 flex items-center gap-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="avatar">A</div>
        <div className="flex-1 min-w-0">
          <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>Adam</div>
          <div className="truncate" style={{ fontSize: 12, color: "var(--fg-faint)" }}>JSP · London</div>
        </div>
        <button onClick={onOpenSettings} className="btn-ghost p-1.5" title="Mission control (⌘,)">
          <Icon.Settings className="lucide-sm" />
        </button>
      </div>
    </aside>
  );
}

export default Sidebar;
