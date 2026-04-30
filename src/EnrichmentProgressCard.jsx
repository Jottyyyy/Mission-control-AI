import React, { useState, useEffect, useRef } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// Marker the backend's /chat layer rewrites enrichment.run actions to.
// Token shape mirrors uuid4 (8-4-4-4-12 hex). Anchored loosely so a stray
// marker mid-paragraph still matches.
export const ENRICHMENT_PROGRESS_MARKER_RE =
  /\[\[enrichment-progress:([0-9a-fA-F-]{10,})\]\]/g;

// How often we poll the status endpoint while a job is processing.
// 1s is the spec — fast enough that the UI feels live, slow enough
// that a 200-row run is only ~300 polls (negligible).
const POLL_INTERVAL_MS = 1000;
// On network blips, back off to this ceiling so we don't hammer the
// backend while it's restarting. Spec calls for up to 30s.
const POLL_BACKOFF_MAX_MS = 30000;

function formatDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

// Smoothly animate a numeric value toward `target`. The bar percentage
// jumps without this when row N completes — a 1% jump every poll feels
// twitchy. Easing toward target each frame looks like real progress.
function useSmoothValue(target, durationMs = 600) {
  const [value, setValue] = useState(target);
  const rafRef = useRef(null);
  const fromRef = useRef(target);
  const toRef = useRef(target);
  const startRef = useRef(performance.now());

  useEffect(() => {
    if (target === toRef.current) return;
    fromRef.current = value;
    toRef.current = target;
    startRef.current = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - startRef.current) / durationMs);
      // ease-out cubic — fast at the start, gentle landing.
      const eased = 1 - Math.pow(1 - t, 3);
      const next = fromRef.current + (toRef.current - fromRef.current) * eased;
      setValue(next);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return value;
}

function ProgressBar({ percent }) {
  const animated = useSmoothValue(percent);
  return (
    <div
      style={{
        position: "relative",
        height: 8,
        background: "var(--border)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          width: `${Math.max(0, Math.min(100, animated))}%`,
          background: "var(--accent)",
          borderRadius: 999,
          transition: "background 200ms ease",
        }}
      />
    </div>
  );
}

function StatLine({ label, value, tone }) {
  const colorMap = {
    success: "var(--accent)",
    warn: "var(--fg-muted)",
    error: "#c44",
    default: "var(--fg)",
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: colorMap[tone] || colorMap.default }}>
      <strong style={{ fontWeight: 600 }}>{value}</strong>
      <span style={{ color: "var(--fg-muted)" }}>{label}</span>
    </span>
  );
}

const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 14,
  background: "var(--bg-elev)",
  margin: "8px 0",
  fontSize: 13,
};

function ProcessingCard({ state }) {
  const total = state.total || 0;
  const progress = state.progress || 0;
  const percent = total > 0 ? (progress / total) * 100 : 0;
  const enricherLabel = state.current_enricher
    ? state.current_enricher.replace(/_/g, " ")
    : null;

  return (
    <div style={cardStyle}>
      <div className="flex items-center gap-2" style={{ marginBottom: 10, fontSize: 14, fontWeight: 500 }}>
        <span
          className="pulse-dot"
          style={{ width: 8, height: 8, borderRadius: 999, background: "var(--accent)", display: "inline-block" }}
        />
        <span>Enriching leads — {progress.toLocaleString()} / {total.toLocaleString()}</span>
        <span style={{ marginLeft: "auto", color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}>
          {Math.round(percent)}%
        </span>
      </div>

      <ProgressBar percent={percent} />

      <div style={{ marginTop: 10, color: "var(--fg-muted)", lineHeight: 1.5 }}>
        {state.current_company ? (
          <>
            Now: <strong style={{ color: "var(--fg)", fontWeight: 500 }}>{state.current_company}</strong>
            {enricherLabel ? <> · {enricherLabel}</> : null}
          </>
        ) : (
          <>Starting…</>
        )}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 14, flexWrap: "wrap" }}>
        <StatLine label="enriched" value={state.rows_enriched ?? 0} tone="success" />
        <StatLine label="unmatched" value={state.rows_unmatched ?? 0} tone="warn" />
        {(state.rows_errored ?? 0) > 0 && (
          <StatLine label="errors" value={state.rows_errored} tone="error" />
        )}
      </div>

      <div style={{ marginTop: 10, display: "flex", gap: 14, color: "var(--fg-muted)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
        <span>Elapsed: {formatDuration(state.elapsed_seconds)}</span>
        <span>ETA: {state.eta_seconds == null ? "estimating…" : `~${formatDuration(state.eta_seconds)}`}</span>
      </div>
    </div>
  );
}

function CompletedCard({ state }) {
  const downloadName = state.download_filename || "enriched.csv";
  const isCsv = state.summary && state.summary.input_type === "csv";
  const isSheets = state.summary && state.summary.input_type === "sheets";
  const updatedCells = state.summary && state.summary.updated_cells;
  const truncated = state.summary && state.summary.truncated;

  return (
    <div style={cardStyle}>
      <div className="flex items-center gap-2" style={{ marginBottom: 10, fontSize: 14, fontWeight: 500 }}>
        <Icon.Check className="lucide" style={{ color: "var(--accent)" }} />
        <span>Enrichment complete — {state.progress} / {state.total}</span>
        <span style={{ marginLeft: "auto", color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}>
          {formatDuration(state.elapsed_seconds)}
        </span>
      </div>

      <ProgressBar percent={100} />

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
        <StatLine label="enriched" value={state.rows_enriched ?? 0} tone="success" />
        <StatLine label="unmatched (no Companies House record)" value={state.rows_unmatched ?? 0} tone="warn" />
        {(state.rows_errored ?? 0) > 0 && (
          <StatLine label="errors" value={state.rows_errored} tone="error" />
        )}
        {isSheets && updatedCells != null && (
          <StatLine label="cells updated in sheet" value={updatedCells} />
        )}
      </div>

      {state.credits_used && Object.keys(state.credits_used).length > 0 && (
        <div style={{ marginTop: 8, color: "var(--fg-muted)", fontSize: 12 }}>
          Credits used:{" "}
          {Object.entries(state.credits_used)
            .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
            .join(", ")}
          {Object.values(state.credits_used).every((v) => v === 0) ? " (free tier)" : ""}
        </div>
      )}

      {truncated && (
        <div style={{ marginTop: 8, color: "var(--fg-muted)", fontSize: 12, fontStyle: "italic" }}>
          Capped at 200 rows — re-run with the rest if needed.
        </div>
      )}

      {state.output_url && isCsv && (
        <a
          href={state.output_url}
          download={downloadName}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 12,
            padding: "8px 12px",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--fg)",
            textDecoration: "none",
            fontWeight: 500,
            fontSize: 13,
          }}
        >
          <Icon.Download className="lucide" /> Download {downloadName}
        </a>
      )}
      {state.output_url && isSheets && (
        <a
          href={state.output_url}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 12,
            padding: "8px 12px",
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            background: "var(--bg)",
            color: "var(--fg)",
            textDecoration: "none",
            fontWeight: 500,
            fontSize: 13,
          }}
        >
          <Icon.ExternalLink className="lucide" /> Open updated sheet
        </a>
      )}
    </div>
  );
}

function FailedCard({ state }) {
  return (
    <div style={{ ...cardStyle, borderColor: "#c44" }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 8, fontSize: 14, fontWeight: 500, color: "#c44" }}>
        <Icon.AlertTriangle className="lucide" />
        Enrichment failed
      </div>
      <div style={{ color: "var(--fg-muted)", fontSize: 13, lineHeight: 1.5 }}>
        {state.error || "Unknown error."}
      </div>
      <div style={{ marginTop: 8, color: "var(--fg-muted)", fontSize: 12 }}>
        Processed {state.progress} of {state.total} before failing.
      </div>
    </div>
  );
}

export default function EnrichmentProgressCard({ jobId }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(POLL_INTERVAL_MS);
  const stopRef = useRef(false);

  useEffect(() => {
    stopRef.current = false;
    let timer = null;
    let currentInterval = POLL_INTERVAL_MS;

    const poll = async () => {
      if (stopRef.current) return;
      try {
        const res = await fetch(`${API_BASE}/enrichment/status/${jobId}`);
        if (res.status === 404) {
          // The job has expired off the registry. Tell the user something
          // useful instead of polling forever.
          setError("Job no longer available (it may have expired).");
          stopRef.current = true;
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        setState(body);
        setError(null);
        currentInterval = POLL_INTERVAL_MS;
        setPollIntervalMs(currentInterval);
        if (body.status === "completed" || body.status === "failed") {
          stopRef.current = true;
          return;
        }
      } catch (e) {
        // Network blip — back off but keep trying. Spec: don't show
        // "failed" prematurely, the backend may just be reloading.
        currentInterval = Math.min(currentInterval * 2, POLL_BACKOFF_MAX_MS);
        setPollIntervalMs(currentInterval);
      }
      if (!stopRef.current) {
        timer = setTimeout(poll, currentInterval);
      }
    };

    // Kick off immediately rather than waiting POLL_INTERVAL_MS for the
    // first state — the chat surface should populate within ~100ms.
    poll();

    return () => {
      stopRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (error) {
    return (
      <div style={cardStyle}>
        <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>{error}</div>
      </div>
    );
  }

  if (!state) {
    return (
      <div style={cardStyle}>
        <div className="flex items-center gap-2" style={{ color: "var(--fg-muted)", fontSize: 13 }}>
          <span
            className="pulse-dot"
            style={{ width: 8, height: 8, borderRadius: 999, background: "var(--fg-faint)", display: "inline-block" }}
          />
          Starting enrichment…
        </div>
      </div>
    );
  }

  if (state.status === "completed") return <CompletedCard state={state} />;
  if (state.status === "failed") return <FailedCard state={state} />;
  return <ProcessingCard state={state} />;
}
