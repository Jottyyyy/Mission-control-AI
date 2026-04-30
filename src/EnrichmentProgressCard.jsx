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

// Compact preview of N enriched rows.  `rows` is the API's `sample_rows`
// payload — each entry is a flat dict like
// {Company Name, Status, Directors_summary, Shareholders_summary}.
function SampleTable({ rows }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 6 }}>
        Sample (first {rows.length} row{rows.length === 1 ? "" : "s"}):
      </div>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 6,
          overflow: "hidden",
          fontSize: 12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {rows.map((row, idx) => {
          const name = row["Company Name"] || "(no name)";
          const bits = [];
          if (row.Status) bits.push(row.Status);
          if (row.Directors_summary) bits.push(row.Directors_summary);
          if (row.Shareholders_summary) bits.push(row.Shareholders_summary);
          const detail = bits.length ? bits.join(" · ") : "no Companies House data";
          return (
            <div
              key={idx}
              style={{
                display: "flex",
                gap: 12,
                padding: "6px 10px",
                borderTop: idx === 0 ? "none" : "1px solid var(--border)",
                background: idx % 2 ? "var(--bg)" : "var(--bg-elev)",
              }}
            >
              <span
                style={{
                  flex: "1 1 50%",
                  color: "var(--fg)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={name}
              >
                {name}
              </span>
              <span
                style={{
                  flex: "1 1 50%",
                  color: bits.length ? "var(--fg-muted)" : "var(--fg-faint)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={detail}
              >
                {detail}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Field fill summary — per-column count of how many rows the pipeline
// added a value to. The check vs warning glyph is a quick "complete vs
// patchy" visual cue.
function FieldFills({ counts, total }) {
  const entries = Object.entries(counts || {});
  if (entries.length === 0) return null;
  // Sort by count desc — most-filled fields first.
  entries.sort((a, b) => b[1] - a[1]);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 12, color: "var(--fg-muted)", marginBottom: 6 }}>
        Fields added:
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {entries.map(([field, count]) => {
          const ratio = total > 0 ? count / total : 0;
          // Use the existing accent for full coverage, faded fg for patchy.
          const isFull = ratio === 1;
          const isPatchy = ratio < 0.5;
          const Glyph = isFull ? Icon.Check : Icon.AlertTriangle;
          return (
            <div
              key={field}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <Glyph
                className="lucide-xs"
                style={{
                  color: isFull
                    ? "var(--accent)"
                    : isPatchy
                    ? "#c44"
                    : "var(--fg-muted)",
                  flexShrink: 0,
                }}
              />
              <span style={{ flex: 1, color: "var(--fg)" }}>{field}</span>
              <span style={{ color: "var(--fg-muted)" }}>
                {count} {count === 1 ? "row" : "rows"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Lazy-loaded full-data preview. Fetched once per expansion. Capped at
// `MAX_ROWS_PREVIEW` rows to keep the chat scroll usable.
const MAX_ROWS_PREVIEW = 200;

function FullPreview({ jobId, total, downloadFilename }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [header, setHeader] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleToggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (rows !== null) return; // already fetched
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/enrichment/preview/${jobId}?offset=0&limit=${MAX_ROWS_PREVIEW}`,
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.json();
      setRows(body.rows || []);
      setHeader(body.header || []);
    } catch (e) {
      setError(e.message || "Failed to load preview.");
    } finally {
      setLoading(false);
    }
  };

  if (total <= 0) return null;

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={handleToggle}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: "var(--fg-muted)",
          fontSize: 12,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {open ? "▾" : "▸"} {open ? "Hide" : "Show"} all {total.toLocaleString()} rows
      </button>
      {open && (
        <div
          style={{
            marginTop: 8,
            border: "1px solid var(--border)",
            borderRadius: 6,
            maxHeight: 400,
            overflow: "auto",
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {loading && (
            <div style={{ padding: 12, color: "var(--fg-muted)" }}>Loading…</div>
          )}
          {error && (
            <div style={{ padding: 12, color: "#c44" }}>{error}</div>
          )}
          {!loading && !error && rows && rows.length === 0 && (
            <div style={{ padding: 12, color: "var(--fg-muted)" }}>No rows.</div>
          )}
          {!loading && !error && rows && rows.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--bg-elev)" }}>
                <tr>
                  {header.map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "6px 8px",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--fg-muted)",
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ background: i % 2 ? "var(--bg)" : "transparent" }}>
                    {header.map((h) => {
                      const v = r[h] ?? "";
                      return (
                        <td
                          key={h}
                          style={{
                            padding: "5px 8px",
                            borderBottom: "1px solid var(--border)",
                            color: v ? "var(--fg)" : "var(--fg-faint)",
                            maxWidth: 220,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={v}
                        >
                          {v || "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {total > MAX_ROWS_PREVIEW && rows && (
            <div style={{ padding: 8, color: "var(--fg-muted)", fontSize: 11, fontStyle: "italic", borderTop: "1px solid var(--border)" }}>
              Showing first {MAX_ROWS_PREVIEW} of {total.toLocaleString()} —
              download {downloadFilename || "the CSV"} for the full set.
            </div>
          )}
        </div>
      )}
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

      <FieldFills counts={state.field_fill_counts} total={state.total} />
      <SampleTable rows={state.sample_rows} />

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

      {/* Full-data lazy preview — CSV jobs only (Sheets jobs return their
          data in the sheet itself; preview endpoint refuses Sheets jobs). */}
      {isCsv && state.total > 0 && (
        <FullPreview
          jobId={state.job_id}
          total={state.total}
          downloadFilename={downloadName}
        />
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
