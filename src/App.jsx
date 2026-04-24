import React, { useState, useEffect, useCallback } from 'react';
import Data from './data.jsx';
import Sidebar from './Sidebar.jsx';
import Dashboard from './Dashboard.jsx';
import Chat from './Chat.jsx';
import PipelinePanel from './PipelinePanel.jsx';
import MissionControl from './MissionControl.jsx';
import Tweaks from './Tweaks.jsx';
import Onboarding from './Onboarding.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// Cross-file signal: Connections → App to re-open onboarding when Adam
// clicks Reconfigure. Duplicated as a literal in Connections.jsx to avoid
// an import cycle (App → MissionControl → Connections).
const REOPEN_ONBOARDING_EVENT = "mc:reopen-onboarding";
const SKIP_STORAGE_KEY = "adam.onboardingSkipped";

function App() {
  const defaults = window.__TWEAKS || {};

  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("adam.dark");
    if (saved !== null) return saved === "1";
    return !!defaults.dark;
  });
  // screen: "dashboard" | "assistant" | "mission"
  const [screen, setScreen] = useState(() => {
    return localStorage.getItem("adam.screen") || "dashboard";
  });
  // Where to return from Mission Control
  const [missionReturn, setMissionReturn] = useState("dashboard");
  // Which assistant is active: "personal" | "marketing"
  const [assistantKey, setAssistantKey] = useState(() => {
    return localStorage.getItem("adam.assistant") || "personal";
  });
  const [dashboardState, setDashboardState] = useState(() => {
    return localStorage.getItem("adam.dashState") || "empty-recurring";
  });
  // uuid of the selected conversation (null = new / empty)
  const [activeConversationUuid, setActiveConversationUuid] = useState(() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("conversation") || null;
    } catch (_) {
      return null;
    }
  });
  const [prefill, setPrefill] = useState("");
  const [rightRailOpen, setRightRailOpen] = useState(false);
  const [pipelineState, setPipelineState] = useState(defaults.pipelineState || "starting");
  const [pipelineMinimized, setPipelineMinimized] = useState(false);

  const [tweaksOpen, setTweaksOpen] = useState(false);

  // Onboarding gate: "checking" while we poll /onboarding/status on boot.
  // "show" when the backend says we're unconfigured and the user hasn't
  // clicked Skip. "hidden" otherwise (main app visible).
  const [onboardingPhase, setOnboardingPhase] = useState("checking");

  const checkOnboarding = useCallback(async ({ forceReopen = false } = {}) => {
    if (!forceReopen) {
      // Honour the skip flag on normal boot — user explicitly deferred setup.
      try {
        if (localStorage.getItem(SKIP_STORAGE_KEY) === "1") {
          setOnboardingPhase("hidden");
          return;
        }
      } catch (_) { /* localStorage denied — fall through */ }
    }
    try {
      const res = await fetch(`${API_BASE}/onboarding/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.needs_onboarding || forceReopen) {
        setOnboardingPhase("show");
      } else {
        setOnboardingPhase("hidden");
      }
    } catch (_) {
      // If we can't reach the backend yet (it's still booting), don't flash
      // onboarding — show the main app and let the chat's own error UI handle
      // the offline case. A subsequent reload will retry this check.
      setOnboardingPhase("hidden");
    }
  }, []);

  useEffect(() => { checkOnboarding(); }, [checkOnboarding]);

  // MissionControl → Reconfigure dispatches this event; force the welcome
  // screen open even if the backend still reports configured (e.g. user
  // wants to rotate keys).
  useEffect(() => {
    const handler = () => {
      try { localStorage.removeItem(SKIP_STORAGE_KEY); } catch (_) {}
      checkOnboarding({ forceReopen: true });
    };
    window.addEventListener(REOPEN_ONBOARDING_EVENT, handler);
    return () => window.removeEventListener(REOPEN_ONBOARDING_EVENT, handler);
  }, [checkOnboarding]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("adam.dark", dark ? "1" : "0");
  }, [dark]);

  useEffect(() => { localStorage.setItem("adam.screen", screen); }, [screen]);
  useEffect(() => { localStorage.setItem("adam.assistant", assistantKey); }, [assistantKey]);
  useEffect(() => { localStorage.setItem("adam.dashState", dashboardState); }, [dashboardState]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setDark((d) => !d);
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        setMissionReturn(screen === "mission" ? "dashboard" : screen);
        setScreen("mission");
        return;
      }
      if (mod && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        handleNewConvo();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tweaks host
  useEffect(() => {
    const onMsg = (e) => {
      const m = e.data;
      if (!m || !m.type) return;
      if (m.type === "__activate_edit_mode") setTweaksOpen(true);
      if (m.type === "__deactivate_edit_mode") setTweaksOpen(false);
    };
    window.addEventListener("message", onMsg);
    try { window.parent.postMessage({ type: "__edit_mode_available" }, "*"); } catch (_) {}
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const updateUrl = (uuid) => {
    try {
      const url = new URL(window.location.href);
      if (uuid) url.searchParams.set("conversation", uuid);
      else url.searchParams.delete("conversation");
      window.history.pushState({}, "", url.toString());
    } catch (_) { /* ignore */ }
  };

  const handleNewConvo = () => {
    setDashboardState("empty-recurring");
    setActiveConversationUuid(null);
    updateUrl(null);
    setPrefill("");
  };

  const handleSelectConversation = (uuid) => {
    setActiveConversationUuid(uuid);
    updateUrl(uuid);
    setPrefill("");
    setDashboardState(uuid ? "active" : "empty-recurring");
  };

  const handleOpenAssistant = (key, maybePrefill) => {
    setAssistantKey(key);
    setScreen("assistant");
    setActiveConversationUuid(null);
    updateUrl(null);
    setDashboardState("empty-recurring");
    setPrefill(maybePrefill || "");
  };

  const handleTriggerPipeline = () => {
    setPipelineState("starting");
    setRightRailOpen(true);
    setPipelineMinimized(false);
  };

  const handleClosePipeline = () => {
    setRightRailOpen(false);
    setPipelineMinimized(false);
  };
  const handleMinimizePipeline = () => {
    setRightRailOpen(false);
    setPipelineMinimized(true);
  };
  const handleRestorePipeline = () => {
    setRightRailOpen(true);
    setPipelineMinimized(false);
  };

  // Tweak proxy
  const tweakState = {
    dark, screen, assistantKey, dashboardState, rightRailOpen, pipelineState,
  };
  const setTweakState = (next) => {
    if (next.dark !== dark) setDark(next.dark);
    if (next.screen !== screen) setScreen(next.screen);
    if (next.assistantKey !== assistantKey) setAssistantKey(next.assistantKey);
    if (next.dashboardState !== dashboardState) setDashboardState(next.dashboardState);
    if (next.rightRailOpen !== rightRailOpen) {
      setRightRailOpen(next.rightRailOpen);
      if (next.rightRailOpen) setPipelineMinimized(false);
    }
    if (next.pipelineState !== pipelineState) setPipelineState(next.pipelineState);
  };

  const screenLabel =
    screen === "dashboard" ? "Dashboard" :
    screen === "mission" ? "Mission control" :
    Data.assistants[assistantKey].name;

  // While we're still talking to /onboarding/status, render nothing — the
  // backend takes up to 30s to go healthy on a cold packaged launch and the
  // main UI would briefly flash "chat broken" if we showed it first.
  if (onboardingPhase === "checking") {
    return (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ background: "var(--bg)", color: "var(--fg-faint)", fontSize: 13 }}
      >
        <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: 999, background: "var(--fg-faint)", display: "inline-block" }} />
      </div>
    );
  }

  if (onboardingPhase === "show") {
    return (
      <Onboarding
        onDone={() => {
          try { localStorage.removeItem(SKIP_STORAGE_KEY); } catch (_) {}
          setOnboardingPhase("hidden");
        }}
        onSkip={() => {
          try { localStorage.setItem(SKIP_STORAGE_KEY, "1"); } catch (_) {}
          setOnboardingPhase("hidden");
        }}
      />
    );
  }

  return (
    <div
      className="h-full w-full flex"
      data-screen-label={screenLabel}
      style={{ background: "var(--bg)", color: "var(--fg)" }}
    >
      {screen === "dashboard" && (
        <Dashboard
          onOpenAssistant={handleOpenAssistant}
          onOpenSettings={() => { setMissionReturn("dashboard"); setScreen("mission"); }}
          dark={dark}
          setDark={setDark}
        />
      )}

      {screen === "assistant" && (
        <>
          <Sidebar
            assistantKey={assistantKey}
            activeConversationUuid={activeConversationUuid}
            onSelectConversation={handleSelectConversation}
            onNewConvo={handleNewConvo}
            onOpenSettings={() => { setMissionReturn("assistant"); setScreen("mission"); }}
            onBackToDashboard={() => { setScreen("dashboard"); setRightRailOpen(false); setPipelineMinimized(false); }}
          />
          <Chat
            assistantKey={assistantKey}
            mode={dashboardState}
            setMode={setDashboardState}
            onTriggerPipeline={handleTriggerPipeline}
            rightRailOpen={rightRailOpen}
            pipelineMinimized={pipelineMinimized}
            onRestorePipeline={handleRestorePipeline}
            prefill={prefill}
            activeConversationUuid={activeConversationUuid}
            setActiveConversationUuid={(uuid) => {
              setActiveConversationUuid(uuid);
              if (uuid) setDashboardState("active");
            }}
          />
          {rightRailOpen && (
            <PipelinePanel
              state={pipelineState}
              setState={setPipelineState}
              onClose={handleClosePipeline}
              onMinimize={handleMinimizePipeline}
            />
          )}
        </>
      )}

      {screen === "mission" && (
        <MissionControl
          onBack={() => setScreen(missionReturn)}
          onOpenChatPrefilled={(key, text) => handleOpenAssistant(key, text)}
        />
      )}

      <Tweaks visible={tweaksOpen} state={tweakState} setState={setTweakState} />
    </div>
  );
}

export default App;
