import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// ---------------------------------------------------------------------------
// Guided-setup modal.
//
// Triggered before Adam processes a lead batch when one or more of the three
// integrations (Pomanda, Cognism, Lusha) haven't been configured. Backs onto
// the existing /integrations/{id}/{credentials,test,status} endpoints — no
// backend changes needed.
//
// Two views:
//   overview  → one card per required tool, each linking to its wizard
//   wizard    → three-step flow (instructions → paste key → verify)
// ---------------------------------------------------------------------------

const TOOL_ORDER = ["pomanda", "cognism", "lusha", "ghl", "google"];

// Fallback for legacy single-key tools that don't declare a fields array.
const DEFAULT_FIELDS = [{ key: "api_key", label: "API Key", password: true }];

const TOOL_CONTENT = {
  pomanda: {
    label: "Pomanda",
    tagline: "Finds the main decision-maker at each company",
    stepOneDescription:
      "Pomanda wraps UK Companies House data. It finds shareholder information to identify the real decision-maker (MAN) at each company.",
    dashboardUrl: "https://pomanda.com/dashboard",
    keyPath: "Settings → API Keys → Generate new key",
    whoToAsk: "Mara at JSP can add you. Email mara@jacksonswiss.com",
    keyFormatHint: null,
    icon: "Building",
  },
  cognism: {
    label: "Cognism",
    tagline: "Finds email addresses and mobile numbers",
    stepOneDescription:
      "Cognism is our primary enrichment tool. We use it first because it has 10,000 monthly credits — cheaper per contact than Lusha.",
    dashboardUrl: "https://app.cognism.com",
    keyPath: "Settings → API → API Keys → Create new key",
    whoToAsk: "Mara at JSP manages the Cognism account.",
    keyFormatHint: "Your key starts with 'API-P-…' and has a UUID after it.",
    icon: "Mail",
  },
  lusha: {
    label: "Lusha",
    tagline: "Fallback for missing contact info",
    stepOneDescription:
      "Lusha costs about £1 per contact, so we only use it when Cognism can't find an email or mobile. It protects your budget.",
    dashboardUrl: "https://dashboard.lusha.com",
    keyPath: "Settings → API → Create Key",
    whoToAsk: "Mara at JSP handles Lusha subscriptions.",
    keyFormatHint: "Your key is in UUID format: xxxxxxxx-xxxx-xxxx…",
    icon: "Phone",
  },
  ghl: {
    label: "GoHighLevel",
    tagline: "Marketing CRM for contacts and conversations",
    stepOneDescription:
      "GoHighLevel is your marketing automation platform. Mission Control uses it to sync verified contacts from the MAN workflow, manage opportunities, and view conversations.",
    dashboardUrl: "https://app.gohighlevel.com",
    keyPath: "Settings → Integrations → Private Integrations → Create new integration",
    whoToAsk: "Tom at JSP runs the GHL Agency. He can grant Adam access if needed.",
    keyFormatHint: "Token starts with 'pit-' and is followed by a UUID. Location ID is a short alphanumeric string from Settings → Business Profile.",
    icon: "TrendingUp",
    setupSteps: [
      "Open GHL → Settings (gear icon, top-right)",
      "Click Integrations → Private Integrations → Create new integration",
      "Name it 'Mission Control AI'",
      "Tick the scopes: contacts.readonly + .write, opportunities.readonly + .write, conversations.readonly + .write, calendars.readonly + .write, locations.readonly",
      "Click Generate token (it starts with 'pit-')",
      "Copy your Location ID from Settings → Business Profile",
    ],
    fields: [
      { key: "api_key",     label: "Private Integration Token", password: true,
        placeholder: "pit-xxxxxxxx-xxxx-xxxx-xxxx-…" },
      { key: "location_id", label: "Location ID",               password: false,
        placeholder: "From Settings → Business Profile" },
    ],
  },
  google: {
    label: "Google Workspace",
    tagline: "Calendar, Gmail, Drive, Sheets, and Docs",
    stepOneDescription:
      "Mission Control connects to your Google account via OAuth. One sign-in grants access to calendar, email, drive, spreadsheets, and docs.",
    dashboardUrl: "https://console.cloud.google.com",
    keyPath: "APIs & Services → Credentials → Create OAuth client ID",
    whoToAsk: "Tom or your IT lead can help with the Cloud Console setup if you've never used it.",
    keyFormatHint: "Client ID ends in `.apps.googleusercontent.com`. Client secret starts with `GOCSPX-`.",
    icon: "Mail",
    setupSteps: [
      "Open the Google Cloud Console (link above)",
      "Create a new project (or pick an existing one)",
      "APIs & Services → Library → enable: Calendar, Gmail, Drive, Sheets, Docs",
      "APIs & Services → OAuth consent screen → set up (External, Testing)",
      "Add yourself as a Test User (your Google email)",
      "APIs & Services → Credentials → Create OAuth client ID",
      "Application type: Web application",
      "Authorized redirect URIs: http://localhost:8001/auth/google/callback",
      "Copy Client ID and Client Secret",
      "Paste below — then I'll open Google in your browser to sign in",
    ],
    fields: [
      { key: "client_id",     label: "Client ID",     password: false,
        placeholder: "...apps.googleusercontent.com" },
      { key: "client_secret", label: "Client Secret", password: true,
        placeholder: "GOCSPX-…" },
    ],
    // After Save, instead of POST /integrations/google/test, run the OAuth
    // flow: open the browser to /auth/google/start and poll /auth/google/status
    // until connected: true (or timeout).
    custom_verify: "google_oauth",
  },
};

export default function SetupModal({
  open,
  onClose,
  onConfigured,          // (toolId) => void — called after a successful verify
  requiredTools = TOOL_ORDER,   // subset of tool ids
  context = "to run this workflow",
}) {
  const [view, setView] = useState("overview");       // "overview" | "wizard"
  const [activeTool, setActiveTool] = useState(null);
  const [step, setStep] = useState(1);                // 1 | 2 | 3
  const [values, setValues] = useState({});           // { [fieldKey]: string }
  const [revealed, setRevealed] = useState({});       // { [fieldKey]: bool }
  const [verifyState, setVerifyState] = useState("idle"); // idle | loading | success | error
  const [verifyError, setVerifyError] = useState("");
  const [connected, setConnected] = useState({});     // {pomanda: bool, ...}
  const [confirmClose, setConfirmClose] = useState(false);
  const backdropRef = useRef(null);

  // Refresh connected-status whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setView("overview");
    setActiveTool(null);
    setStep(1);
    setValues({});
    setRevealed({});
    setVerifyState("idle");
    setVerifyError("");
    setConfirmClose(false);

    let cancelled = false;
    (async () => {
      try {
        const [manRes, googleRes] = await Promise.all([
          fetch(`${API_BASE}/workflow/man/status`).then((r) => r.json()).catch(() => ({})),
          fetch(`${API_BASE}/integrations/google/status`).then((r) => r.json()).catch(() => ({})),
        ]);
        if (!cancelled) {
          setConnected({
            pomanda: !!manRes.pomanda_configured,
            cognism: !!manRes.cognism_configured,
            lusha:   !!manRes.lusha_configured,
            ghl:     !!manRes.ghl_configured,
            // /integrations/google/status returns connected when both
            // refresh_token and client_id+secret exist; the `required_fields`
            // check on `connected: true` already gates that for us.
            google:  !!googleRes.connected,
          });
        }
      } catch {
        if (!cancelled) setConnected({});
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Esc → close (with confirm mid-wizard).
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        attemptClose();
      }
      if (e.key === "Enter" && view === "wizard") {
        // Forward Enter within the wizard unless typing in a textarea.
        if (document.activeElement?.tagName === "TEXTAREA") return;
        if (step === 1) advanceStep();
        else if (step === 2 && allFieldsFilled() && verifyState !== "loading") handleVerify();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, view, step, values, activeTool, verifyState]);

  const fieldsForTool = (toolId) => TOOL_CONTENT[toolId]?.fields || DEFAULT_FIELDS;

  const allFieldsFilled = () => {
    if (!activeTool) return false;
    const fields = fieldsForTool(activeTool);
    return fields.every((f) => (values[f.key] || "").trim().length > 0);
  };

  // Derive ordered tool list — placed BEFORE the early-return so hook order
  // remains stable between open and closed renders (React error #310).
  const orderedTools = useMemo(
    () => TOOL_ORDER.filter((t) => requiredTools.includes(t)),
    [requiredTools]
  );

  if (!open) return null;

  const attemptClose = () => {
    if (view === "wizard" && verifyState !== "success") {
      setConfirmClose(true);
      return;
    }
    onClose?.();
  };

  const confirmAndClose = () => {
    setConfirmClose(false);
    onClose?.();
  };

  const firstMissing = orderedTools.find((t) => !connected[t]);

  const openWizard = (toolId) => {
    setActiveTool(toolId);
    setStep(1);
    setValues({});
    setRevealed({});
    setVerifyState("idle");
    setVerifyError("");
    setView("wizard");
  };

  const backToOverview = () => {
    setView("overview");
    setActiveTool(null);
  };

  const advanceStep = () => {
    if (step < 3) setStep(step + 1);
  };

  const handleVerify = async () => {
    if (!activeTool) return;
    const fields = fieldsForTool(activeTool);
    const credentials = {};
    for (const f of fields) {
      const v = (values[f.key] || "").trim();
      if (!v) return; // button is gated, but defend anyway
      credentials[f.key] = v;
    }
    setStep(3);
    setVerifyState("loading");
    setVerifyError("");
    try {
      const saveRes = await fetch(`${API_BASE}/integrations/${activeTool}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials }),
      });
      if (!saveRes.ok) {
        const b = await saveRes.json().catch(() => ({}));
        throw new Error(b?.detail || `HTTP ${saveRes.status}`);
      }

      // Custom verify path — Google's flow is "save creds, open browser to
      // OAuth, poll status until connected". The standard /test endpoint
      // would fail because we don't have an access_token yet.
      const customVerify = TOOL_CONTENT[activeTool]?.custom_verify;
      if (customVerify === "google_oauth") {
        await runGoogleOAuthVerify();
        return;
      }

      const testRes = await fetch(`${API_BASE}/integrations/${activeTool}/test`, {
        method: "POST",
      });
      const testData = await testRes.json().catch(() => ({}));
      if (testRes.ok && testData?.success) {
        setVerifyState("success");
        setConnected((prev) => ({ ...prev, [activeTool]: true }));
        onConfigured?.(activeTool);
      } else {
        setVerifyState("error");
        setVerifyError(testData?.error || "Credentials saved, but the test call failed.");
      }
    } catch (err) {
      setVerifyState("error");
      setVerifyError(
        err instanceof TypeError
          ? "Can't reach the local backend. Is it running?"
          : (err?.message || "Something went wrong saving the credentials.")
      );
    }
  };

  // Google OAuth: open the consent URL in a popup, then poll
  // /auth/google/status every 2s until either `connected: true` or a 60-second
  // timeout. The popup auto-closes itself after the callback HTML loads — we
  // don't depend on `window.open()`'s return handle so popup-blockers that
  // redirect to a new tab still work.
  const runGoogleOAuthVerify = async () => {
    setVerifyState("oauth_waiting");
    setVerifyError("");
    let url;
    try {
      const r = await fetch(`${API_BASE}/auth/google/start`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.detail || `HTTP ${r.status}`);
      url = d?.auth_url;
      if (!url) throw new Error("No auth URL returned.");
    } catch (err) {
      setVerifyState("error");
      setVerifyError(err?.message || "Couldn't start Google sign-in.");
      return;
    }

    try { window.open(url, "mc-google-oauth", "width=520,height=700"); } catch { /* popup blocked — Adam will see "still waiting" */ }

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2000));
      try {
        const s = await fetch(`${API_BASE}/auth/google/status`).then((r) => r.json());
        if (s?.connected) {
          setVerifyState("success");
          setConnected((prev) => ({ ...prev, google: true }));
          onConfigured?.("google");
          return;
        }
      } catch { /* transient — keep polling */ }
    }

    setVerifyState("error");
    setVerifyError("Couldn't complete sign-in within 60 seconds. Click 'Try again' below.");
  };

  const onBackdropClick = (e) => {
    if (e.target === backdropRef.current) attemptClose();
  };

  return (
    <div
      ref={backdropRef}
      onMouseDown={onBackdropClick}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.4)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="setup-modal-title"
    >
      <div
        className="slide-in-top"
        style={{
          background: "var(--bg)",
          borderRadius: 12,
          border: "1px solid var(--border)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.15)",
          width: "100%",
          maxWidth: 560,
          maxHeight: "calc(100vh - 48px)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {confirmClose ? (
          <ConfirmCloseView onStay={() => setConfirmClose(false)} onLeave={confirmAndClose} />
        ) : view === "overview" ? (
          <OverviewView
            onClose={attemptClose}
            orderedTools={orderedTools}
            connected={connected}
            context={context}
            firstMissing={firstMissing}
            onOpenWizard={openWizard}
            onSkip={onClose}
          />
        ) : (
          <WizardView
            toolId={activeTool}
            step={step}
            fields={fieldsForTool(activeTool)}
            values={values}
            setValues={setValues}
            revealed={revealed}
            setRevealed={setRevealed}
            allFilled={allFieldsFilled()}
            verifyState={verifyState}
            verifyError={verifyError}
            connected={connected}
            orderedTools={orderedTools}
            onClose={attemptClose}
            onBackToOverview={backToOverview}
            onAdvance={advanceStep}
            onStepBack={() => setStep((s) => Math.max(1, s - 1))}
            onVerify={handleVerify}
            onRetry={() => { setVerifyState("idle"); setVerifyError(""); setStep(2); }}
            onNextTool={(nextTool) => openWizard(nextTool)}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewView({
  onClose, orderedTools, connected, context, firstMissing, onOpenWizard, onSkip,
}) {
  return (
    <>
      <ModalHeader title="Setting up your workflow" titleId="setup-modal-title" onClose={onClose} />
      <div style={{ padding: "16px 24px 8px 24px", fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.55 }}>
        {context}, you'll need to connect the services below. I'll walk you through each one.
      </div>

      <div style={{ padding: "8px 24px 16px 24px", overflowY: "auto", flex: 1 }}>
        {orderedTools.map((toolId) => (
          <ToolRow
            key={toolId}
            toolId={toolId}
            configured={!!connected[toolId]}
            onSetUp={() => onOpenWizard(toolId)}
          />
        ))}
      </div>

      <ModalFooter>
        <button
          className="btn-ghost px-3 py-1.5"
          style={{ fontSize: 13, color: "var(--fg-muted)" }}
          onClick={onSkip}
        >
          Skip for now
        </button>
        {firstMissing ? (
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "8px 16px", display: "flex", alignItems: "center", gap: 6 }}
            onClick={() => onOpenWizard(firstMissing)}
          >
            Set up {TOOL_CONTENT[firstMissing].label} first
            <Icon.ChevronRight className="lucide-xs" />
          </button>
        ) : (
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "8px 16px" }}
            onClick={onClose}
          >
            All set
          </button>
        )}
      </ModalFooter>
    </>
  );
}

function ToolRow({ toolId, configured, onSetUp }) {
  const content = TOOL_CONTENT[toolId];
  const IconCmp = Icon[content.icon] || Icon.Key;
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 14,
        padding: "12px 14px",
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--bg-elev)",
        marginBottom: 8,
      }}
    >
      <IconCmp className="lucide-sm" style={{ color: "var(--fg-muted)", flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)" }}>{content.label}</div>
        <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{content.tagline}</div>
        <div style={{ fontSize: 12, marginTop: 4, color: configured ? "var(--green)" : "var(--fg-faint)" }}>
          {configured ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon.Check className="lucide-xs" /> Connected
            </span>
          ) : (
            "Not configured"
          )}
        </div>
      </div>
      <button
        className={configured ? "btn-secondary px-3 py-1.5" : "btn-primary px-3 py-1.5"}
        style={{ fontSize: 13, whiteSpace: "nowrap" }}
        onClick={onSetUp}
      >
        {configured ? "Reconfigure" : "Set up"}
        {!configured && <Icon.ChevronRight className="lucide-xs" style={{ marginLeft: 4, display: "inline", verticalAlign: "-2px" }} />}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

function WizardView({
  toolId, step, fields, values, setValues, revealed, setRevealed, allFilled,
  verifyState, verifyError, connected, orderedTools,
  onClose, onBackToOverview, onAdvance, onStepBack, onVerify, onRetry, onNextTool,
}) {
  const content = TOOL_CONTENT[toolId];
  if (!content) return null;

  return (
    <>
      <ModalHeader
        title={`Setting up ${content.label}`}
        titleId="setup-modal-title"
        onClose={onClose}
        onBack={step === 1 ? onBackToOverview : onStepBack}
      />
      <div style={{ padding: "12px 24px 4px 24px" }}>
        <StepIndicator current={step} total={3} />
      </div>

      <div style={{ padding: "12px 24px 16px 24px", overflowY: "auto", flex: 1 }}>
        {step === 1 && <StepOne content={content} />}
        {step === 2 && (
          <StepTwo
            content={content}
            fields={fields}
            values={values}
            setValues={setValues}
            revealed={revealed}
            setRevealed={setRevealed}
          />
        )}
        {step === 3 && (
          <StepThree
            toolId={toolId}
            content={content}
            verifyState={verifyState}
            verifyError={verifyError}
            connected={connected}
            orderedTools={orderedTools}
            onRetry={onRetry}
            onNextTool={onNextTool}
            onDone={onClose}
            onBackToOverview={onBackToOverview}
          />
        )}
      </div>

      {step === 1 && (
        <ModalFooter>
          <button
            className="btn-ghost px-3 py-1.5"
            style={{ fontSize: 13, color: "var(--fg-muted)" }}
            onClick={onBackToOverview}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "8px 16px", display: "flex", alignItems: "center", gap: 6 }}
            onClick={onAdvance}
          >
            Next
            <Icon.ChevronRight className="lucide-xs" />
          </button>
        </ModalFooter>
      )}

      {step === 2 && (
        <ModalFooter>
          <button
            className="btn-ghost px-3 py-1.5"
            style={{ fontSize: 13, color: "var(--fg-muted)" }}
            onClick={onStepBack}
          >
            Back
          </button>
          <button
            className="btn-primary"
            style={{ fontSize: 14, padding: "8px 16px", display: "flex", alignItems: "center", gap: 6 }}
            onClick={onVerify}
            disabled={!allFilled}
          >
            Verify
            <Icon.ChevronRight className="lucide-xs" />
          </button>
        </ModalFooter>
      )}

      {/* Step 3 has its own action buttons inside the panel. */}
    </>
  );
}

function StepOne({ content }) {
  return (
    <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.6 }}>
      <p style={{ marginTop: 0, color: "var(--fg-muted)" }}>{content.stepOneDescription}</p>

      {content.setupSteps ? (
        <>
          <div style={{ marginTop: 14 }}>
            <a
              href={content.dashboardUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
              style={{
                fontSize: 13, padding: "6px 12px",
                display: "inline-flex", alignItems: "center", gap: 6,
                textDecoration: "none", color: "var(--fg)",
              }}
            >
              <Icon.ExternalLink className="lucide-xs" />
              Open {content.dashboardUrl.replace(/^https?:\/\//, "")}
            </a>
          </div>
          <ol style={{ paddingLeft: 18, margin: "14px 0 0 0" }}>
            {content.setupSteps.map((step, i) => (
              <li key={i} style={{ marginBottom: 8 }}>{step}</li>
            ))}
          </ol>
        </>
      ) : (
        <ol style={{ paddingLeft: 18, margin: "14px 0 0 0" }}>
          <li style={{ marginBottom: 10 }}>
            Open {content.label}'s dashboard
            <div style={{ marginTop: 6 }}>
              <a
                href={content.dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary"
                style={{
                  fontSize: 13, padding: "6px 12px",
                  display: "inline-flex", alignItems: "center", gap: 6,
                  textDecoration: "none", color: "var(--fg)",
                }}
              >
                <Icon.ExternalLink className="lucide-xs" />
                Open {content.dashboardUrl.replace(/^https?:\/\//, "")}
              </a>
            </div>
          </li>
          <li style={{ marginBottom: 10 }}>
            Sign in
            <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 4 }}>
              If you don't have an account, {content.whoToAsk}
            </div>
          </li>
          <li style={{ marginBottom: 10 }}>
            Go to <span style={{ fontFamily: "Menlo, Courier, monospace", fontSize: 13 }}>{content.keyPath}</span>
          </li>
          <li style={{ marginBottom: 10 }}>
            Copy the key to your clipboard
          </li>
        </ol>
      )}

      <p style={{ marginTop: 14, color: "var(--fg-muted)" }}>
        Got it? Click Next when you have what you need.
      </p>
    </div>
  );
}

function StepTwo({ content, fields, values, setValues, revealed, setRevealed }) {
  const intro = fields.length === 1
    ? `Paste your ${content.label} API key:`
    : `Paste each ${content.label} value:`;

  return (
    <div style={{ fontSize: 14, color: "var(--fg)" }}>
      <div style={{ marginBottom: 10, color: "var(--fg-muted)" }}>
        {intro}
      </div>

      <div className="flex flex-col" style={{ gap: 10 }}>
        {fields.map((f, i) => {
          const isPassword = !!f.password;
          const isRevealed = !!revealed[f.key];
          const EyeCmp = isRevealed ? Icon.EyeOff : Icon.Eye;
          return (
            <div key={f.key}>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  marginBottom: 4,
                  letterSpacing: "0.02em",
                }}
              >
                {f.label}
              </div>
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 8,
                  border: "1px solid var(--border-strong)",
                  borderRadius: 8,
                  padding: "2px 4px 2px 10px",
                  background: "var(--bg-elev)",
                }}
              >
                <input
                  type={isPassword && !isRevealed ? "password" : "text"}
                  value={values[f.key] || ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  placeholder={f.placeholder || ""}
                  autoFocus={i === 0}
                  spellCheck={false}
                  style={{
                    flex: 1,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontFamily: "Menlo, Courier, monospace",
                    fontSize: 13,
                    padding: "8px 4px",
                    color: "var(--fg)",
                  }}
                  aria-label={`${content.label} ${f.label}`}
                />
                {isPassword && (
                  <button
                    type="button"
                    onClick={() => setRevealed((s) => ({ ...s, [f.key]: !s[f.key] }))}
                    className="btn-ghost p-1.5"
                    style={{ color: "var(--fg-muted)" }}
                    aria-label={isRevealed ? "Hide value" : "Show value"}
                    title={isRevealed ? "Hide value" : "Show value"}
                  >
                    <EyeCmp className="lucide-sm" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {content.keyFormatHint && (
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginTop: 8 }}>
          {content.keyFormatHint}
        </div>
      )}
      <div
        style={{
          marginTop: 16, padding: "10px 12px",
          background: "var(--bg-soft)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 12,
          color: "var(--fg-muted)",
          lineHeight: 1.55,
        }}
      >
        Values are stored in macOS Keychain — encrypted and only accessible by
        Mission Control on this Mac. They never leave your machine.
      </div>
    </div>
  );
}

function StepThree({
  toolId, content, verifyState, verifyError, connected, orderedTools,
  onRetry, onNextTool, onDone, onBackToOverview,
}) {
  const nextMissing = orderedTools.find((t) => t !== toolId && !connected[t]);

  if (verifyState === "loading") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 0", fontSize: 14, color: "var(--fg)" }}>
        <Icon.Loader className="lucide-sm spin" style={{ color: "var(--accent)" }} />
        Testing your {content.label} API key…
      </div>
    );
  }
  if (verifyState === "oauth_waiting") {
    return (
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", fontSize: 14, color: "var(--fg)" }}>
          <Icon.Loader className="lucide-sm spin" style={{ color: "var(--accent)" }} />
          Waiting for you to sign in with Google…
        </div>
        <div style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55, padding: "0 0 8px 0" }}>
          A browser window should have opened. Grant access to Calendar,
          Gmail, Drive, Sheets, and Docs. The window will close itself when
          you're done.
        </div>
      </div>
    );
  }
  if (verifyState === "success") {
    return (
      <div>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 0", fontSize: 15, fontWeight: 500, color: "var(--green)",
          }}
        >
          <Icon.CheckCircle2 className="lucide-sm" />
          {content.label} connected
        </div>
        <div style={{ fontSize: 13, color: "var(--fg-muted)", marginBottom: 16 }}>
          {toolId === "pomanda" && "You can now verify MANs automatically from Companies House data."}
          {toolId === "cognism" && "You can now enrich missing emails and mobile numbers."}
          {toolId === "lusha" && "Lusha will fill in any contact info Cognism can't find."}
          {toolId === "ghl" && "Mission Control can now sync verified contacts and view GHL conversations."}
          {toolId === "google" && "Calendar, Gmail, Drive, Sheets, and Docs are all connected."}
        </div>
        <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn-secondary px-3 py-1.5"
            style={{ fontSize: 13 }}
            onClick={onBackToOverview}
          >
            Back to overview
          </button>
          {nextMissing && (
            <button
              className="btn-primary"
              style={{ fontSize: 14, padding: "8px 16px", display: "flex", alignItems: "center", gap: 6 }}
              onClick={() => onNextTool(nextMissing)}
            >
              Set up {TOOL_CONTENT[nextMissing].label} next
              <Icon.ChevronRight className="lucide-xs" />
            </button>
          )}
          {!nextMissing && (
            <button className="btn-primary" style={{ fontSize: 14, padding: "8px 16px" }} onClick={onDone}>
              Done
            </button>
          )}
        </div>
      </div>
    );
  }
  // error
  return (
    <div>
      <div
        style={{
          display: "flex", alignItems: "flex-start", gap: 10,
          padding: "10px 12px",
          background: "rgba(180,67,44,0.06)",
          border: "1px solid rgba(180,67,44,0.35)",
          borderRadius: 8,
        }}
      >
        <Icon.AlertTriangle className="lucide-sm" style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13, color: "var(--fg)", lineHeight: 1.5, flex: 1 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>Couldn't connect to {content.label}</div>
          <div style={{ color: "var(--fg-muted)" }}>{verifyError}</div>
        </div>
      </div>
      <div className="flex items-center" style={{ gap: 8, marginTop: 14 }}>
        <button
          className="btn-secondary px-3 py-1.5"
          style={{ fontSize: 13 }}
          onClick={onBackToOverview}
        >
          Back
        </button>
        <button
          className="btn-primary"
          style={{ fontSize: 14, padding: "8px 16px" }}
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function ModalHeader({ title, titleId, onClose, onBack }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", gap: 12 }}
    >
      <div className="flex items-center" style={{ gap: 8, minWidth: 0 }}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="btn-ghost p-1.5"
            style={{ color: "var(--fg-muted)" }}
            aria-label="Back"
          >
            <Icon.ArrowLeft className="lucide-sm" />
          </button>
        )}
        <div id={titleId} style={{ fontSize: 15, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </div>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="btn-ghost p-1.5"
        style={{ color: "var(--fg-muted)" }}
        aria-label="Close"
      >
        <Icon.X className="lucide-sm" />
      </button>
    </div>
  );
}

function ModalFooter({ children }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: "12px 20px", borderTop: "1px solid var(--border)", gap: 8 }}
    >
      {children}
    </div>
  );
}

function StepIndicator({ current, total }) {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <span style={{ fontSize: 12, color: "var(--fg-muted)", letterSpacing: "0.02em" }}>
        Step {current} of {total}
      </span>
      <div className="flex items-center" style={{ gap: 4 }}>
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            style={{
              width: 6, height: 6, borderRadius: 999,
              background: i < current ? "var(--accent)" : "var(--border-strong)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ConfirmCloseView({ onStay, onLeave }) {
  return (
    <>
      <div style={{ padding: "20px 24px 4px 24px", fontSize: 15, fontWeight: 500, color: "var(--fg)" }}>
        Close without finishing?
      </div>
      <div style={{ padding: "4px 24px 20px 24px", fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}>
        You're partway through setting up an integration. If you close now, the key you were about
        to paste won't be saved.
      </div>
      <ModalFooter>
        <button className="btn-ghost px-3 py-1.5" style={{ fontSize: 13, color: "var(--fg-muted)" }} onClick={onStay}>
          Keep going
        </button>
        <button className="btn-secondary" style={{ fontSize: 13, padding: "8px 14px" }} onClick={onLeave}>
          Close anyway
        </button>
      </ModalFooter>
    </>
  );
}
