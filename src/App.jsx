import React, { useState, useEffect } from 'react';
import Data from './data.jsx';
import Sidebar from './Sidebar.jsx';
import Dashboard from './Dashboard.jsx';
import Chat from './Chat.jsx';
import PipelinePanel from './PipelinePanel.jsx';
import MissionControl from './MissionControl.jsx';
import Tweaks from './Tweaks.jsx';

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
