import React from 'react';

// Floating tweaks panel — visible when toolbar Tweaks mode is on.
function Tweaks({ visible, state, setState }) {
  if (!visible) return null;

  const { dark, screen, dashboardState, rightRailOpen, pipelineState } = state;

  const Section = ({ title, children }) => (
    <div className="mb-3">
      <div style={{ fontSize: 11, color: "var(--fg-faint)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );

  const Row = ({ label, children }) => (
    <div className="flex items-center justify-between py-1">
      <span style={{ fontSize: 13, color: "var(--fg-muted)" }}>{label}</span>
      {children}
    </div>
  );

  const Pill = ({ active, onClick, children }) => (
    <button
      onClick={onClick}
      className="px-2 py-1"
      style={{
        fontSize: 12,
        borderRadius: 6,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--fg-muted)",
        border: active ? "1px solid transparent" : "1px solid var(--border-strong)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );

  return (
    <div className="tweaks-panel">
      <div className="flex items-center justify-between mb-3">
        <div style={{ fontSize: 13, fontWeight: 500 }}>Tweaks</div>
        <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>toggle in toolbar</div>
      </div>

      <Section title="Appearance">
        <Row label="Dark mode">
          <div
            className={"toggle " + (dark ? "on" : "")}
            onClick={() => setState({ ...state, dark: !dark })}
          >
            <div className="knob" />
          </div>
        </Row>
      </Section>

      <Section title="Screen">
        <div className="flex gap-1 flex-wrap">
          <Pill active={screen === "dashboard"} onClick={() => setState({ ...state, screen: "dashboard" })}>Dashboard</Pill>
          <Pill active={screen === "mission"} onClick={() => setState({ ...state, screen: "mission" })}>Mission control</Pill>
        </div>
      </Section>

      {screen === "dashboard" && (
        <Section title="Dashboard state">
          <div className="flex gap-1 flex-wrap">
            <Pill active={dashboardState === "empty-first"} onClick={() => setState({ ...state, dashboardState: "empty-first" })}>First run</Pill>
            <Pill active={dashboardState === "empty-recurring"} onClick={() => setState({ ...state, dashboardState: "empty-recurring" })}>New convo</Pill>
            <Pill active={dashboardState === "active"} onClick={() => setState({ ...state, dashboardState: "active" })}>Active</Pill>
          </div>
        </Section>
      )}

      <Section title="Pipeline panel">
        <Row label="Show panel">
          <div
            className={"toggle " + (rightRailOpen ? "on" : "")}
            onClick={() => setState({ ...state, rightRailOpen: !rightRailOpen })}
          >
            <div className="knob" />
          </div>
        </Row>
        {rightRailOpen && (
          <div className="flex gap-1 flex-wrap mt-2">
            <Pill active={pipelineState === "starting"} onClick={() => setState({ ...state, pipelineState: "starting" })}>Starting</Pill>
            <Pill active={pipelineState === "running"} onClick={() => setState({ ...state, pipelineState: "running" })}>Running</Pill>
            <Pill active={pipelineState === "done"} onClick={() => setState({ ...state, pipelineState: "done" })}>Done</Pill>
            <Pill active={pipelineState === "review"} onClick={() => setState({ ...state, pipelineState: "review" })}>Review</Pill>
          </div>
        )}
      </Section>

      <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--fg-faint)", lineHeight: 1.5 }}>
          Shortcuts: ⌘⇧D dark mode, ⌘, mission control, ⌘N new conversation.
        </div>
      </div>
    </div>
  );
}

export default Tweaks;
