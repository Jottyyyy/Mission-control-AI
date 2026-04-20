import React, { useState } from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';

function MissionControl({ onBack }) {
  const [tab, setTab] = useState("apps"); // apps | skills | memory | activity
  const [panelApp, setPanelApp] = useState(null);

  const Header = () => (
    <div
      className="flex items-center justify-between px-6 py-4"
      style={{ borderBottom: "1px solid var(--border)" }}
    >
      <div className="flex items-center gap-3">
        <button className="btn-ghost p-1.5" onClick={onBack} title="Back">
          <Icon.ArrowLeft className="lucide-sm" />
        </button>
        <div style={{ fontSize: 16, fontWeight: 500 }}>Mission control</div>
      </div>
      <div className="flex items-center gap-2" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        <span className="green-dot" />
        <span>Running on your Mac Mini</span>
      </div>
    </div>
  );

  const TabRail = () => {
    const tabs = [
      { id: "apps", label: "Connected apps", icon: "Grid" },
      { id: "skills", label: "Skills", icon: "Sparkles" },
      { id: "memory", label: "Memory", icon: "Brain" },
      { id: "activity", label: "Activity log", icon: "Activity" },
    ];
    return (
      <div
        className="flex-shrink-0 p-4 flex flex-col gap-1"
        style={{
          width: 220,
          borderRight: "1px solid var(--border)",
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            className={"tab-row " + (tab === t.id ? "active" : "")}
            onClick={() => setTab(t.id)}
            style={{ textAlign: "left" }}
          >
            {React.createElement(Icon[t.icon], { className: "lucide-sm" })}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
    );
  };

  const Apps = () => (
    <div className="px-8 py-8 overflow-y-auto flex-1">
      <div className="mb-8">
        <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Connected apps</h2>
        <p style={{ color: "var(--fg-muted)", fontSize: 14 }}>
          Your assistant can see and use what you've connected here. Nothing leaves this Mac Mini.
        </p>
      </div>

      <div style={{ color: "var(--fg-faint)", fontSize: 12, marginBottom: 12 }}>Connected</div>
      {Data.connectedApps.length > 0 ? (
        <div className="grid grid-cols-3 gap-4 mb-10">
          {Data.connectedApps.map((a) => (
            <div key={a.name} className="card p-4">
              <div className="flex items-center gap-3">
                <div className="logo-square" style={{ color: "var(--accent)" }}>
                  {React.createElement(Icon[a.icon], { className: "lucide-sm" })}
                </div>
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div>
                  <div className="flex items-center gap-1.5 mt-0.5" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                    <span className="green-dot" />
                    <span>Connected</span>
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 10, lineHeight: 1.5 }}>
                {a.desc}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="card px-5 py-6 mb-10"
          style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}
        >
          Nothing connected yet. Connect tools below to unlock assistant capabilities.
        </div>
      )}

      <div style={{ color: "var(--fg-faint)", fontSize: 12, marginBottom: 12 }}>Available to add</div>
      <div className="grid grid-cols-3 gap-4">
        {Data.availableApps.map((a) => (
          <button
            key={a.name}
            className="card p-4 text-left"
            onClick={() => setPanelApp(a)}
            style={{ cursor: "pointer" }}
          >
            <div className="flex items-center gap-3">
              <div className="logo-square" style={{ color: "var(--fg-muted)" }}>
                {React.createElement(Icon[a.icon], { className: "lucide-sm" })}
              </div>
              <div className="flex-1 min-w-0">
                <div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div>
                <div className="flex items-center gap-1.5 mt-0.5" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                  <span className="gray-dot" />
                  <span>Not connected</span>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 10, lineHeight: 1.5 }}>
              {a.desc}
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  const Skills = () => {
    const [toggles, setToggles] = useState(() => {
      const init = {};
      Data.skills.forEach((s) => { init[s.id] = s.on; });
      return init;
    });
    const [galleryOpen, setGalleryOpen] = useState(false);

    const personal  = Data.skills.filter((s) => s.group === "personal");
    const marketing = Data.skills.filter((s) => s.group === "marketing");

    const ScaffoldBadge = () => (
      <span
        style={{
          fontSize: 10,
          padding: "1px 6px",
          borderRadius: 999,
          border: "1px solid var(--border-strong)",
          color: "var(--fg-faint)",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
        title="Defined as a scaffold — not yet connected to real APIs."
      >
        Scaffold
      </span>
    );

    const SkillRow = ({ s, first }) => (
      <div
        className="flex items-center gap-4 px-5 py-4"
        style={{ borderTop: first ? "none" : "1px solid var(--border)" }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 14, fontWeight: 500 }}>{s.name}</span>
            {s.status === "scaffold" && <ScaffoldBadge />}
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{s.description}</div>
        </div>
        <div
          className={"toggle " + (toggles[s.id] ? "on" : "")}
          onClick={() => setToggles((t) => ({ ...t, [s.id]: !t[s.id] }))}
        >
          <div className="knob" />
        </div>
      </div>
    );

    const GroupCard = ({ title, items }) => (
      <section className="mb-6">
        <div
          className="px-1 mb-2"
          style={{ fontSize: 12, color: "var(--fg-faint)", letterSpacing: "0.02em" }}
        >
          {title}
        </div>
        <div className="card">
          {items.map((s, i) => <SkillRow key={s.id} s={s} first={i === 0} />)}
        </div>
      </section>
    );

    return (
      <div className="px-8 py-8 overflow-y-auto flex-1">
        <div className="mb-8">
          <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Skills</h2>
          <p style={{ color: "var(--fg-muted)", fontSize: 14 }}>
            Turn abilities on or off. Your assistant only does what's on here.
          </p>
        </div>

        <GroupCard title="Personal" items={personal} />
        <GroupCard title="Marketing" items={marketing} />

        <div className="mt-6">
          <button className="btn-secondary px-4 py-2 flex items-center gap-2" onClick={() => setGalleryOpen(!galleryOpen)}>
            <Icon.Plus className="lucide-sm" />
            Add new skill
          </button>
        </div>

        {galleryOpen && (
          <div className="mt-6 slide-in-top">
            <div style={{ color: "var(--fg-faint)", fontSize: 12, marginBottom: 12 }}>Available skills</div>
            <div className="grid grid-cols-2 gap-4">
              {Data.skillGallery.map((s) => (
                <div key={s.name} className="card p-4 flex items-start gap-3">
                  <div className="logo-square" style={{ color: "var(--fg-muted)" }}>
                    <Icon.Zap className="lucide-sm" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{s.name}</div>
                    <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{s.desc}</div>
                    <button className="btn-ghost mt-3 px-2 py-1" style={{ fontSize: 13, color: "var(--accent)" }}>
                      Add
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const Memory = () => {
    const [bullets, setBullets] = useState(Data.memory);
    const [query, setQuery] = useState("");
    const [convos, setConvos] = useState(Data.recentConvos);
    const [advOpen, setAdvOpen] = useState(false);
    const [confirmReset, setConfirmReset] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);

    const filtered = convos.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));

    return (
      <div className="px-8 py-8 overflow-y-auto flex-1">
        <div className="mb-8">
          <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Memory</h2>
          <p style={{ color: "var(--fg-muted)", fontSize: 14 }}>
            What the assistant remembers — you're in charge of all of it.
          </p>
        </div>

        {/* What I know about you */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <div style={{ fontSize: 14, fontWeight: 500 }}>What I know about you</div>
            <div style={{ fontSize: 12, color: "var(--fg-faint)" }}>{bullets.length} things</div>
          </div>
          <div className="card">
            {bullets.map((b, i) => (
              <div
                key={i}
                className="flex items-start gap-3 px-5 py-3"
                style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
              >
                <div style={{ fontSize: 14, color: "var(--fg)", flex: 1, lineHeight: 1.5 }}>{b}</div>
                <button
                  className="btn-ghost p-1"
                  title="Forget this"
                  onClick={() => setBullets(bullets.filter((_, j) => j !== i))}
                >
                  <Icon.X className="lucide-xs" />
                </button>
              </div>
            ))}
            {bullets.length === 0 && (
              <div className="px-5 py-6 text-center" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
                Nothing saved yet.
              </div>
            )}
          </div>
        </section>

        {/* Recent conversations */}
        <section className="mb-10">
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Recent conversations</div>
          <div className="card">
            <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <Icon.Search className="lucide-sm" style={{ color: "var(--fg-faint)" }} />
              <input
                placeholder="Search conversations"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1, fontSize: 14 }}
              />
            </div>
            {filtered.map((c, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-5 py-3"
                style={{ borderTop: i === 0 ? "none" : "1px solid var(--border)" }}
              >
                <div className="flex-1 min-w-0">
                  <div style={{ fontSize: 14 }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-faint)", marginTop: 2 }}>{c.date}</div>
                </div>
                <button
                  className="btn-ghost p-1"
                  title="Delete"
                  onClick={() => setConvos(convos.filter((x) => x !== c))}
                >
                  <Icon.Trash className="lucide-xs" />
                </button>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-5 py-6 text-center" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
                {query ? "No matches." : "No conversations yet."}
              </div>
            )}
          </div>
        </section>

        {/* Advanced */}
        <section>
          <button
            className="flex items-center gap-2 btn-ghost px-2 py-1.5"
            onClick={() => setAdvOpen(!advOpen)}
            style={{ fontSize: 14, fontWeight: 500 }}
          >
            {advOpen ? <Icon.ChevronDown className="lucide-sm" /> : <Icon.ChevronRight className="lucide-sm" />}
            Advanced
          </button>
          {advOpen && (
            <div className="mt-3 card slide-in-top">
              <div
                className="px-5 py-4 flex items-center justify-between"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                <div>
                  <div style={{ fontSize: 14 }}>Clear short-term context</div>
                  <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>
                    Forget the current conversation's working notes.
                  </div>
                </div>
                {confirmClear ? (
                  <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--fg-muted)" }}>Sure?</span>
                    <button style={{ color: "var(--danger)", fontWeight: 500 }} onClick={() => setConfirmClear(false)}>Clear</button>
                    <button style={{ color: "var(--fg-muted)" }} onClick={() => setConfirmClear(false)}>Cancel</button>
                  </div>
                ) : (
                  <button className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }} onClick={() => setConfirmClear(true)}>
                    Clear
                  </button>
                )}
              </div>
              <div className="px-5 py-4 flex items-center justify-between">
                <div>
                  <div style={{ fontSize: 14, color: "var(--danger)" }}>Reset all memory</div>
                  <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>
                    Forget everything and start fresh. Can't be undone.
                  </div>
                </div>
                {confirmReset ? (
                  <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
                    <span style={{ color: "var(--fg-muted)" }}>Forget everything?</span>
                    <button style={{ color: "var(--danger)", fontWeight: 500 }} onClick={() => setConfirmReset(false)}>
                      Reset
                    </button>
                    <button style={{ color: "var(--fg-muted)" }} onClick={() => setConfirmReset(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-secondary px-3 py-1.5"
                    style={{ fontSize: 13, color: "var(--danger)", borderColor: "var(--border-strong)" }}
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    );
  };

  const Activity = () => {
    const [filter, setFilter] = useState("All");
    const [expanded, setExpanded] = useState(new Set());
    const chips = ["All", "Personal", "Marketing", "Mission Control"];
    const entries = filter === "All" ? Data.activity : Data.activity.filter((a) => a.cat === filter);

    // Compute soft date dividers
    const groupOf = (label) => {
      if (label.startsWith("Yesterday")) return "Yesterday";
      if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(label)) return "Earlier this week";
      return "Today";
    };

    let lastGroup = null;

    return (
      <div className="px-8 py-8 overflow-y-auto flex-1">
        <div className="mb-8">
          <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Activity log</h2>
          <p style={{ color: "var(--fg-muted)", fontSize: 14 }}>
            Everything your assistant has done, most recent first.
          </p>
        </div>

        <div className="flex items-center gap-2 mb-6">
          {chips.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className="step-pill"
              style={
                filter === c
                  ? { background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid transparent", cursor: "pointer" }
                  : { background: "transparent", color: "var(--fg-muted)", border: "1px solid var(--border-strong)", cursor: "pointer" }
              }
            >
              {c}
            </button>
          ))}
        </div>

        {entries.length === 0 && (
          <div
            className="card px-5 py-6"
            style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}
          >
            Nothing yet. Activity will appear here as your assistant does work.
          </div>
        )}

        <div className="relative">
          {entries.map((e, i) => {
            const group = groupOf(e.time);
            const showDivider = group !== lastGroup;
            lastGroup = group;
            const isExpanded = expanded.has(i);
            return (
              <React.Fragment key={i}>
                {showDivider && (
                  <div className="flex items-center gap-3 mt-6 mb-3 first:mt-0">
                    <div style={{ fontSize: 12, color: "var(--fg-faint)" }}>{group}</div>
                    <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
                  </div>
                )}
                <div
                  className="flex gap-4 py-2 cursor-pointer"
                  onClick={() => {
                    const n = new Set(expanded);
                    if (n.has(i)) n.delete(i); else n.add(i);
                    setExpanded(n);
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--fg-faint)",
                      width: 110,
                      flexShrink: 0,
                      paddingTop: 2,
                    }}
                  >
                    {e.time}
                  </div>
                  <div
                    style={{
                      width: 1,
                      background: "var(--border)",
                      flexShrink: 0,
                      position: "relative",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: -3.5,
                        top: 7,
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        background: "var(--bg)",
                        border: "1.5px solid var(--border-strong)",
                      }}
                    />
                  </div>
                  <div className="flex-1 pb-2">
                    <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.5 }}>{e.text}</div>
                    <div style={{ fontSize: 12, color: "var(--fg-faint)", marginTop: 2 }}>{e.cat}</div>
                    {isExpanded && (
                      <div
                        className="mt-2 slide-in-top"
                        style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}
                      >
                        {e.detail}
                      </div>
                    )}
                  </div>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg)" }}>
      <Header />
      <div className="flex-1 flex min-h-0">
        <TabRail />
        <div className="flex-1 flex min-w-0">
          {tab === "apps" && <Apps />}
          {tab === "skills" && <Skills />}
          {tab === "memory" && <Memory />}
          {tab === "activity" && <Activity />}
        </div>
      </div>

      {/* Slide-in panel for app details */}
      {panelApp && (
        <>
          <div
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.08)",
              zIndex: 40,
            }}
            onClick={() => setPanelApp(null)}
          />
          <aside
            className="slide-in-right"
            style={{
              position: "fixed",
              top: 0, right: 0, bottom: 0,
              width: 380,
              background: "var(--bg)",
              borderLeft: "1px solid var(--border)",
              zIndex: 41,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              className="px-6 py-4 flex items-center justify-between"
              style={{ borderBottom: "1px solid var(--border)" }}
            >
              <div className="flex items-center gap-3">
                <div className="logo-square" style={{ color: "var(--fg-muted)" }}>
                  {React.createElement(Icon[panelApp.icon], { className: "lucide-sm" })}
                </div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{panelApp.name}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{panelApp.desc}</div>
                </div>
              </div>
              <button className="btn-ghost p-1.5" onClick={() => setPanelApp(null)}>
                <Icon.X className="lucide-sm" />
              </button>
            </div>
            <div className="flex-1 px-6 py-6 overflow-y-auto">
              <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.6, marginBottom: 20 }}>
                Give the assistant access to your {panelApp.name.toLowerCase()}.
              </div>
              <ul className="flex flex-col gap-3 mb-6">
                {panelApp.explain.map((p, i) => (
                  <li key={i} className="flex items-start gap-3" style={{ fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.55 }}>
                    <span
                      style={{
                        width: 4, height: 4, borderRadius: 999,
                        background: "var(--accent-line)",
                        flexShrink: 0, marginTop: 10,
                      }}
                    />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="p-5" style={{ borderTop: "1px solid var(--border)" }}>
              <button className="btn-primary w-full py-2.5">Connect {panelApp.name}</button>
              <div className="text-center mt-3" style={{ fontSize: 12, color: "var(--fg-faint)" }}>
                You can disconnect at any time.
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

export default MissionControl;
