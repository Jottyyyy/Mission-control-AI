import React, { useState, useEffect } from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';
import {
  API_BASE,
  SoulSection,
  RulesSection,
  AboutYouSection,
  WorkspaceSection,
  NewSkillModal,
} from './SettingsEditor.jsx';
import Connections from './Connections.jsx';

function MissionControl({ onBack, onOpenChatPrefilled }) {
  const [tab, setTab] = useState("connections"); // connections | skills | soul | rules | aboutyou | memory | workspace | activity

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
      { id: "connections", label: "Connections",  icon: "Plug" },
      { id: "skills",      label: "Skills",       icon: "Sparkles" },
      { id: "soul",        label: "Soul",         icon: "Brain" },
      { id: "rules",       label: "Rules",        icon: "FileText" },
      { id: "aboutyou",    label: "About you",    icon: "Users" },
      { id: "memory",      label: "Memory",       icon: "BookOpen" },
      { id: "workspace",   label: "Workspace",    icon: "Folder" },
      { id: "activity",    label: "Activity log", icon: "Activity" },
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

  const Skills = () => {
    const [skills, setSkills] = useState(Data.skills);
    const [fetchError, setFetchError] = useState(null);
    const [modalOpen, setModalOpen] = useState(false);

    const loadSkills = async () => {
      try {
        const res = await fetch(`${API_BASE}/skills`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data.skills)) setSkills(data.skills);
        setFetchError(null);
      } catch (err) {
        setFetchError(err.message || "Could not load skills from backend.");
        // Fall back to the baked-in client list so the UI still shows something.
        setSkills(Data.skills);
      }
    };

    useEffect(() => { loadSkills(); }, []);

    const toggleSkill = async (id) => {
      // Optimistic flip
      setSkills((prev) => prev.map((s) => s.id === id ? { ...s, on: !s.on } : s));
      try {
        const res = await fetch(`${API_BASE}/skills/${encodeURIComponent(id)}/toggle`, { method: "PUT" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        // Roll back if the backend refused.
        setSkills((prev) => prev.map((s) => s.id === id ? { ...s, on: !s.on } : s));
      }
    };

    const personal  = skills.filter((s) => s.group === "personal");
    const marketing = skills.filter((s) => s.group === "marketing");

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

    const CustomBadge = () => (
      <span
        style={{
          fontSize: 10,
          padding: "1px 6px",
          borderRadius: 999,
          color: "var(--accent)",
          background: "var(--accent-soft)",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
        title="Created via the UI."
      >
        Custom
      </span>
    );

    const SkillRow = ({ s, first }) => (
      <div
        className="flex items-center gap-4 px-5 py-4"
        style={{ borderTop: first ? "none" : "1px solid var(--border)" }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ fontSize: 14, fontWeight: 500 }}>{s.name}</span>
            {s.custom && <CustomBadge />}
            {s.status === "scaffold" && <ScaffoldBadge />}
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{s.description}</div>
        </div>
        <div
          className={"toggle " + (s.on ? "on" : "")}
          onClick={() => toggleSkill(s.id)}
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
          {items.length === 0 ? (
            <div className="px-5 py-6 text-center" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              No skills in this group yet.
            </div>
          ) : (
            items.map((s, i) => <SkillRow key={s.id} s={s} first={i === 0} />)
          )}
        </div>
      </section>
    );

    const handleDescribeInChat = () => {
      if (!onOpenChatPrefilled) return;
      onOpenChatPrefilled("personal", "I'd like to create a new skill. What should it do?");
    };

    return (
      <div className="px-4 sm:px-6 lg:px-8 py-8 overflow-y-auto flex-1">
        <div className="mx-auto w-full" style={{ maxWidth: 1120 }}>
        <div className="mb-8">
          <h2 style={{ fontSize: 20, fontWeight: 500, marginBottom: 4 }}>Skills</h2>
          <p style={{ color: "var(--fg-muted)", fontSize: 14 }}>
            Turn abilities on or off. Your assistant only does what's on here.
          </p>
        </div>

        {fetchError && (
          <div
            className="mb-4 px-3 py-2"
            style={{
              fontSize: 13,
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              color: "var(--fg-muted)",
              background: "var(--bg-elev)",
            }}
          >
            {fetchError} — showing a fallback list. Changes won't persist until the backend is reachable.
          </div>
        )}

        <GroupCard title="Personal specialist"  items={personal} />
        <GroupCard title="Marketing specialist" items={marketing} />

        <div className="mt-6 flex items-center gap-2">
          <button className="btn-secondary px-4 py-2 flex items-center gap-2" onClick={() => setModalOpen(true)}>
            <Icon.Plus className="lucide-sm" />
            Add custom skill
          </button>
          {onOpenChatPrefilled && (
            <button
              className="btn-ghost px-3 py-2"
              style={{ fontSize: 13 }}
              onClick={handleDescribeInChat}
              title="Open chat and describe the skill to your assistant"
            >
              <span className="flex items-center gap-1.5">
                <Icon.Sparkles className="lucide-xs" />
                Describe a skill to my assistant
              </span>
            </button>
          )}
        </div>

        <NewSkillModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onCreated={() => loadSkills()}
          onDescribeInChat={onOpenChatPrefilled ? handleDescribeInChat : null}
        />
        </div>
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
      <div className="px-4 sm:px-6 lg:px-8 py-8 overflow-y-auto flex-1">
        <div className="mx-auto w-full" style={{ maxWidth: 960 }}>
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
      <div className="px-4 sm:px-6 lg:px-8 py-8 overflow-y-auto flex-1">
        <div className="mx-auto w-full" style={{ maxWidth: 960 }}>
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
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg)" }}>
      <Header />
      <div className="flex-1 flex min-h-0">
        <TabRail />
        <div className="flex-1 flex min-w-0">
          {tab === "connections" && <Connections />}
          {tab === "skills" && <Skills />}
          {tab === "soul" && <SoulSection />}
          {tab === "rules" && <RulesSection />}
          {tab === "aboutyou" && <AboutYouSection />}
          {tab === "memory" && <Memory />}
          {tab === "workspace" && <WorkspaceSection />}
          {tab === "activity" && <Activity />}
        </div>
      </div>
    </div>
  );
}

export default MissionControl;
