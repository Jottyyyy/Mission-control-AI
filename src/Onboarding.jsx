import React, { useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// First-launch welcome. Adam pastes his Anthropic key, we verify it against
// /v1/messages, then write ~/.openclaw/openclaw.json so chat works.
//
// States:
//   idle        → form visible
//   configuring → spinner after Continue clicked (covers verify + write)
//   success     → checkmark, auto-transitions to main app after ~1s
//   error       → message + Retry, form stays editable
//
// The "Skip for now" path calls onSkip so App.jsx can stash a local flag and
// open the main app regardless — chat will fail until reconfigured, but Adam
// can reach Settings → Reconfigure to come back.

const KEY_PREFIX = "sk-ant-";
const KEY_MIN_LENGTH = 30; // sk-ant- + 20 chars, matches backend regex.
const SAMPLE_PLACEHOLDERS = ["sk-ant-test", "sk-ant-", "sk-ant-xxx"];

function validateKey(raw) {
  const key = (raw || "").trim();
  if (!key) return "Paste your Anthropic API key.";
  if (!key.startsWith(KEY_PREFIX)) return "Anthropic keys start with 'sk-ant-'.";
  if (key.length < KEY_MIN_LENGTH) return "That key looks too short — make sure you copied the whole thing.";
  if (SAMPLE_PLACEHOLDERS.includes(key)) return "That looks like a placeholder — paste the real key.";
  return null;
}

function Onboarding({ onDone, onSkip }) {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState("idle"); // idle | configuring | success | error
  const [clientError, setClientError] = useState("");
  const [serverError, setServerError] = useState("");

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (status === "configuring") return;

    const problem = validateKey(apiKey);
    if (problem) {
      setClientError(problem);
      return;
    }
    setClientError("");
    setServerError("");
    setStatus("configuring");

    try {
      const res = await fetch(`${API_BASE}/onboarding/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anthropic_api_key: apiKey.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        setServerError(data?.error || data?.detail || `Couldn't configure (HTTP ${res.status}).`);
        setStatus("error");
        return;
      }
      setStatus("success");
      // Hand off to App after the checkmark lands so it doesn't feel jumpy.
      setTimeout(() => onDone?.(), 900);
    } catch (err) {
      setServerError(
        err instanceof TypeError
          ? "Can't reach the Mission Control backend. Try relaunching the app."
          : (err?.message || "Something went wrong.")
      );
      setStatus("error");
    }
  };

  const isBusy = status === "configuring";
  const isDone = status === "success";
  const hasError = status === "error";

  return (
    <div
      className="h-full w-full flex items-center justify-center"
      style={{ background: "var(--bg)", color: "var(--fg)" }}
    >
      <div
        className="fade-in"
        style={{
          width: "100%",
          maxWidth: 480,
          padding: "0 24px",
        }}
      >
        <div className="text-center" style={{ marginBottom: 28 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "var(--accent-soft)",
              color: "var(--accent)",
              margin: "0 auto 18px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon.Sparkles className="lucide" />
          </div>
          <h1
            className="font-serif-display"
            style={{ fontSize: 28, margin: "0 0 8px", color: "var(--fg)" }}
          >
            Welcome to Mission Control
          </h1>
          <p style={{ fontSize: 14, color: "var(--fg-muted)", margin: 0, lineHeight: 1.55 }}>
            Let's get you set up — takes about 30 seconds.
          </p>
        </div>

        <div
          className="card"
          style={{ padding: 24 }}
        >
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-faint)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              marginBottom: 18,
              textAlign: "center",
            }}
          >
            Step 1 of 1
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label
                style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}
              >
                AI Provider
              </label>
              <div
                className="flex items-center gap-2"
                style={{
                  padding: "10px 12px",
                  border: "1px solid var(--border-strong)",
                  borderRadius: 8,
                  background: "var(--bg-soft)",
                  fontSize: 14,
                }}
              >
                <Icon.Check className="lucide-xs" style={{ color: "var(--green)" }} />
                <span>Anthropic (Claude)</span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="mc-onboarding-key"
                style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}
              >
                Anthropic API Key
              </label>
              <input
                id="mc-onboarding-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (clientError) setClientError("");
                  if (hasError) {
                    setStatus("idle");
                    setServerError("");
                  }
                }}
                disabled={isBusy || isDone}
                placeholder="sk-ant-..."
                style={{
                  padding: "10px 12px",
                  border: "1px solid " + (clientError ? "var(--danger)" : "var(--border-strong)"),
                  borderRadius: 8,
                  background: "var(--bg)",
                  color: "var(--fg)",
                  fontSize: 14,
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              />
              <div style={{ fontSize: 12, color: "var(--fg-faint)", lineHeight: 1.5 }}>
                Need one? Create it at{" "}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: "var(--accent)" }}
                >
                  console.anthropic.com
                </a>
                {" "}· Stored in macOS Keychain, never in chat history.
              </div>
            </div>

            {clientError && (
              <div
                className="slide-in-top"
                style={{ fontSize: 13, color: "var(--danger)" }}
              >
                {clientError}
              </div>
            )}

            {hasError && serverError && (
              <div
                className="slide-in-top px-3 py-2"
                style={{
                  fontSize: 13,
                  color: "var(--fg)",
                  background: "var(--bg-soft)",
                  border: "1px solid var(--border-strong)",
                  borderLeftWidth: 2,
                  borderLeftColor: "var(--danger)",
                  borderRadius: 6,
                  lineHeight: 1.5,
                }}
              >
                Couldn't configure — {serverError} Check your key and try again.
              </div>
            )}

            {isDone && (
              <div
                className="slide-in-top flex items-center gap-2"
                style={{ fontSize: 13, color: "var(--green)" }}
              >
                <Icon.Check className="lucide-sm" />
                You're ready. Opening Mission Control…
              </div>
            )}

            <div className="flex items-center gap-3" style={{ marginTop: 4 }}>
              <button
                type="submit"
                className="btn-primary flex items-center justify-center gap-2"
                disabled={isBusy || isDone}
                style={{
                  flex: 1,
                  padding: "10px 16px",
                  fontSize: 14,
                  cursor: isBusy || isDone ? "default" : "pointer",
                  opacity: isBusy ? 0.85 : 1,
                }}
              >
                {isBusy && (
                  <Icon.Loader
                    className="lucide-sm"
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                )}
                <span>
                  {isBusy
                    ? "Configuring Mission Control…"
                    : isDone
                    ? "Done"
                    : hasError
                    ? "Try again"
                    : "Continue"}
                </span>
                {!isBusy && !isDone && <Icon.ChevronRight className="lucide-xs" />}
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => onSkip?.()}
                disabled={isBusy || isDone}
                style={{
                  padding: "10px 14px",
                  fontSize: 13,
                  color: "var(--fg-muted)",
                  cursor: isBusy || isDone ? "default" : "pointer",
                }}
              >
                Skip for now
              </button>
            </div>
          </form>
        </div>

        <div
          style={{
            marginTop: 18,
            textAlign: "center",
            fontSize: 12,
            color: "var(--fg-faint)",
            lineHeight: 1.5,
          }}
        >
          You can change this later from Mission Control → Connections.
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default Onboarding;
