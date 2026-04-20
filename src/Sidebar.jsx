import React from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';

// Left rail — assistant-scoped
function Sidebar({ assistantKey, activeConvoId, setActiveConvoId, onNewConvo, onOpenSettings, onBackToDashboard }) {
  const a = Data.assistants[assistantKey];
  const convos = Data.conversations[assistantKey];

  const Group = ({ title, items }) => (
    <div className="mb-4">
      <div className="px-2 pb-1" style={{ fontSize: 12, color: "var(--fg-faint)", letterSpacing: "0.02em" }}>
        {title}
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((c) => (
          <button
            key={c.id}
            onClick={() => setActiveConvoId(c.id)}
            className={"convo-row text-left px-2 py-1.5 text-[14px] " + (activeConvoId === c.id ? "active" : "")}
            style={{ color: activeConvoId === c.id ? "var(--fg)" : "var(--fg-muted)" }}
          >
            <div className="truncate">{c.title}</div>
          </button>
        ))}
      </div>
    </div>
  );

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
      {/* Back to dashboard */}
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

      {/* Assistant identity */}
      <div className="px-5 pt-1 pb-3">
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 2 }}>Working with</div>
        <div className="flex items-center gap-2">
          <div
            className="logo-square"
            style={{ width: 22, height: 22, color: "var(--accent)" }}
          >
            {React.createElement(Icon[a.icon], { className: "lucide-xs" })}
          </div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div>
        </div>
      </div>

      {/* New conversation */}
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
        {(convos.today.length + convos.yesterday.length + convos.last7.length) === 0 ? (
          <div className="px-2 py-6" style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Your recent conversations will appear here.
          </div>
        ) : (
          <>
            {convos.today.length > 0 && <Group title="Today" items={convos.today} />}
            {convos.yesterday.length > 0 && <Group title="Yesterday" items={convos.yesterday} />}
            {convos.last7.length > 0 && <Group title="Last 7 days" items={convos.last7} />}
          </>
        )}
      </div>

      <div
        className="px-3 py-3 flex items-center gap-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div className="avatar">SA</div>
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
