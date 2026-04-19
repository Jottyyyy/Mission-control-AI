// Landing dashboard: overview + two assistant cards
function Dashboard({ onOpenAssistant, onOpenSettings, dark, setDark }) {
  const pa = Data.assistants.personal;
  const ma = Data.assistants.marketing;

  const AssistantCard = ({ a, tint }) => (
    <button
      onClick={() => onOpenAssistant(a.key)}
      className="card text-left p-6 flex flex-col"
      style={{ minHeight: 260, transition: "border-color 150ms ease", cursor: "pointer" }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
    >
      <div className="flex items-center gap-3">
        <div
          className="logo-square"
          style={{
            background: tint,
            color: "var(--accent)",
            border: "1px solid var(--border)",
          }}
        >
          {React.createElement(Icon[a.icon], { className: "lucide-sm" })}
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{a.name}</div>
          <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{a.blurb}</div>
        </div>
      </div>

      <div className="mt-6 flex-1">
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 8 }}>
          Recent
        </div>
        <div className="flex flex-col gap-2">
          {a.recent.map((r) => (
            <div key={r.title} className="flex items-center justify-between">
              <div style={{ fontSize: 14, color: "var(--fg)" }} className="truncate pr-4">{r.title}</div>
              <div style={{ fontSize: 12, color: "var(--fg-faint)", flexShrink: 0 }}>{r.time}</div>
            </div>
          ))}
        </div>
      </div>

      <div
        className="mt-6 pt-4 flex items-center justify-between"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          <span style={{ color: "var(--fg)", fontWeight: 500 }}>{a.activityToday}</span> things done today
        </div>
        <div className="flex items-center gap-1.5" style={{ fontSize: 13, color: "var(--accent)" }}>
          <span>Open</span>
          <Icon.ChevronRight className="lucide-xs" />
        </div>
      </div>
    </button>
  );

  return (
    <div className="flex-1 flex flex-col" style={{ background: "var(--bg)" }}>
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 sm:px-8 py-4 gap-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            style={{
              width: 24, height: 24, borderRadius: 6,
              background: "var(--accent)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              color: "white", fontSize: 12, fontWeight: 500,
              flexShrink: 0,
            }}
          >A</div>
          <div className="truncate" style={{ fontSize: 14, fontWeight: 500 }}>Adam's Assistant</div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4 flex-shrink-0">
          <div className="hidden md:flex items-center gap-2" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
            <span className="green-dot" />
            <span>Running on your Mac Mini</span>
          </div>
          <span className="md:hidden green-dot" title="Running on your Mac Mini" />
          <button className="btn-ghost p-1.5" onClick={() => setDark(!dark)} title={dark ? "Light mode" : "Dark mode"}>
            {dark ? <Icon.Sun className="lucide-sm" /> : <Icon.Moon className="lucide-sm" />}
          </button>
          <button className="btn-ghost p-1.5" onClick={onOpenSettings} title="Mission control (⌘,)">
            <Icon.Settings className="lucide-sm" />
          </button>
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto px-4 sm:px-8 py-8 sm:py-12" style={{ maxWidth: 960 }}>
          {/* Greeting */}
          <div className="fade-in">
            <h1 className="font-serif-display" style={{ lineHeight: 1.1, fontSize: "clamp(30px, 6vw, 44px)" }}>
              Good {(() => { const h = new Date().getHours(); return h<12?"morning":h<17?"afternoon":"evening"; })()}, Adam.
            </h1>
            <p style={{ marginTop: 14, color: "var(--fg-muted)", fontSize: 16 }}>
              Who would you like to work with?
            </p>
          </div>

          {/* Briefing card */}
          <div
            className="mt-8 px-5 py-4 fade-in"
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
            <div style={{ fontSize: 15, color: "var(--fg)", lineHeight: 1.6 }}>
              {Data.briefing}
            </div>
          </div>

          {/* Two assistants */}
          <div className="mt-8 sm:mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
            <AssistantCard a={pa} tint="var(--accent-soft)" />
            <AssistantCard a={ma} tint="var(--accent-soft)" />
          </div>

          {/* Quick actions */}
          <div className="mt-8 sm:mt-10">
            <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 12 }}>Quick actions</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                className="chip text-left px-4 py-3"
                style={{ fontSize: 14 }}
                onClick={() => onOpenAssistant("personal", "What's on my calendar today?")}
              >
                <span style={{ color: "var(--fg-muted)", marginRight: 8, fontSize: 12 }}>Personal</span>
                What's on my calendar today?
              </button>
              <button
                className="chip text-left px-4 py-3"
                style={{ fontSize: 14 }}
                onClick={() => onOpenAssistant("marketing", "Pull 20 leads from the Zint batch")}
              >
                <span style={{ color: "var(--fg-muted)", marginRight: 8, fontSize: 12 }}>Marketing</span>
                Pull 20 leads from the Zint batch
              </button>
              <button
                className="chip text-left px-4 py-3"
                style={{ fontSize: 14 }}
                onClick={() => onOpenAssistant("marketing", "Who's the MAN at Acme Manufacturing Ltd?")}
              >
                <span style={{ color: "var(--fg-muted)", marginRight: 8, fontSize: 12 }}>Marketing</span>
                Who's the MAN at Acme Manufacturing Ltd?
              </button>
              <button
                className="chip text-left px-4 py-3"
                style={{ fontSize: 14 }}
                onClick={() => onOpenAssistant("personal", "Draft a quick note to Tom")}
              >
                <span style={{ color: "var(--fg-muted)", marginRight: 8, fontSize: 12 }}>Personal</span>
                Draft a quick note to Tom
              </button>
            </div>
          </div>

          <div className="mt-10 text-center" style={{ fontSize: 12, color: "var(--fg-faint)" }}>
            Everything you say stays on this Mac Mini.
          </div>
        </div>
      </div>
    </div>
  );
}

window.Dashboard = Dashboard;
