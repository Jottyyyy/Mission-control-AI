import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// ---------------------------------------------------------------------------
// MAN workflow UI — Sir Adam's primary daily flow.
//
// v1.14 — Zint-aware. A Zint row carries a *candidate* MAN + contact, so the
// UI emphasises verification status (verified / upgraded / as-is) and shows
// per-field source attribution (zint / pomanda / cognism / lusha) rather than
// presenting enrichment as the sole work product.
//
// Contract with the backend:
//   GET  /workflow/man/status                    → readiness check
//   POST /workflow/man/upload-spreadsheet        → parse CSV preview
//   POST /workflow/man/process-batch             → run verify + enrich
// ---------------------------------------------------------------------------

const MAX_LEADS = 200;
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

const PROGRESS_MESSAGES = [
  "Verifying MANs against Pomanda…",
  "Applying JSP priority rules…",
  "Enriching missing contacts via Cognism…",
  "Falling back to Lusha where needed…",
  "Reconciling results…",
];

export default function Workflows({ initialLeads, initialUploadMeta }) {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");

  const [leads, setLeads] = useState(initialLeads || []);
  const [detectedColumns, setDetectedColumns] = useState(initialUploadMeta?.detected_columns || []);
  const [columnMapping, setColumnMapping] = useState(initialUploadMeta?.column_mapping || {});
  const [extraColumns, setExtraColumns] = useState(initialUploadMeta?.extra_columns || []);
  const [selectedIdx, setSelectedIdx] = useState(
    new Set((initialLeads || []).map((_, i) => i))
  );
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadedFilename, setUploadedFilename] = useState(initialUploadMeta?.filename || "");
  const [uploadWarning, setUploadWarning] = useState("");

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [results, setResults] = useState(null);
  const [progressIdx, setProgressIdx] = useState(0);

  const processAbort = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/workflow/man/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch (err) {
        if (!cancelled) setStatusError(
          err instanceof TypeError
            ? "Can't reach the local backend. Is it running?"
            : (err?.message || "Status check failed")
        );
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => {
      setProgressIdx((i) => (i + 1) % PROGRESS_MESSAGES.length);
    }, 2500);
    return () => clearInterval(id);
  }, [processing]);

  // ---------- Upload ----------

  const handleFile = async (file) => {
    setUploadError("");
    setUploadWarning("");
    setResults(null);
    if (!file) return;

    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      setUploadError("Excel files aren't supported yet — please export as CSV first (File → Save As → CSV UTF-8).");
      return;
    }
    if (!name.endsWith(".csv") && file.type !== "text/csv") {
      setUploadError("Only .csv files are supported.");
      return;
    }

    setUploading(true);
    setUploadedFilename(file.name);
    try {
      const text = await file.text();
      const res = await fetch(`${API_BASE}/workflow/man/upload-spreadsheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, csv_content: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLeads([]);
        setDetectedColumns([]);
        setColumnMapping({});
        setExtraColumns([]);
        setSelectedIdx(new Set());
        setUploadError(data?.detail || `Upload failed (HTTP ${res.status}).`);
        return;
      }
      let parsed = data.leads || [];
      if (parsed.length > MAX_LEADS) {
        setUploadWarning(`CSV contained ${parsed.length} rows — truncated to the first ${MAX_LEADS}.`);
        parsed = parsed.slice(0, MAX_LEADS);
      }
      setLeads(parsed);
      setDetectedColumns(data.detected_columns || []);
      setColumnMapping(data.column_mapping || {});
      setExtraColumns(data.extra_columns || []);
      setSelectedIdx(new Set(parsed.map((_, i) => i)));
    } catch (err) {
      setUploadError(
        err instanceof TypeError
          ? "Can't reach the local backend. Is it running?"
          : (err?.message || "Upload failed.")
      );
    } finally {
      setUploading(false);
    }
  };

  const resetBatch = () => {
    setLeads([]);
    setDetectedColumns([]);
    setColumnMapping({});
    setExtraColumns([]);
    setSelectedIdx(new Set());
    setResults(null);
    setUploadError("");
    setUploadWarning("");
    setUploadedFilename("");
    setProcessError("");
  };

  // ---------- Process ----------

  const selectedLeads = useMemo(
    () => leads.filter((_, i) => selectedIdx.has(i)),
    [leads, selectedIdx]
  );

  const startProcess = async () => {
    if (!selectedLeads.length) return;
    setProcessError("");
    setResults(null);
    setProcessing(true);
    setProgressIdx(0);

    const controller = new AbortController();
    processAbort.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), PROCESS_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/workflow/man/process-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: selectedLeads }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setProcessError(data?.detail || `Batch failed (HTTP ${res.status}).`);
        return;
      }
      setResults(data);
    } catch (err) {
      if (err?.name === "AbortError") {
        setProcessError("That took longer than 5 minutes. The backend may still be working — try a smaller batch.");
      } else if (err instanceof TypeError) {
        setProcessError("Can't reach the local backend. Is it running?");
      } else {
        setProcessError(err?.message || "Batch failed.");
      }
    } finally {
      clearTimeout(timeoutId);
      processAbort.current = null;
      setProcessing(false);
    }
  };

  // ---------- Render ----------

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8 overflow-y-auto flex-1">
      <div className="mx-auto w-full" style={{ maxWidth: 1120 }}>
        <PageHeader />
        <StatusBanner status={status} error={statusError} />
        <UploadSection
          onFile={handleFile}
          uploading={uploading}
          uploadError={uploadError}
          uploadWarning={uploadWarning}
          uploadedFilename={uploadedFilename}
          hasLeads={leads.length > 0}
          onReset={resetBatch}
          columnMapping={columnMapping}
          extraColumns={extraColumns}
        />
        {leads.length > 0 && (
          <LeadsTable
            leads={leads}
            selectedIdx={selectedIdx}
            setSelectedIdx={setSelectedIdx}
            results={results}
            processing={processing}
          />
        )}
        {leads.length > 0 && !results && (
          <ProcessBar
            selectedCount={selectedLeads.length}
            processing={processing}
            onProcess={startProcess}
            processError={processError}
            progressMessage={PROGRESS_MESSAGES[progressIdx]}
          />
        )}
        {results && (
          <SummaryBar
            results={results}
            leads={leads}
            detectedColumns={detectedColumns}
            onReset={resetBatch}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------

function PageHeader() {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <Icon.Layers className="lucide" style={{ color: "var(--accent)" }} />
        <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0 }}>MAN identification</h2>
      </div>
      <p style={{ color: "var(--fg-muted)", fontSize: 14, margin: 0 }}>
        Upload a Zint batch. We verify each candidate MAN against Pomanda's shareholders,
        then fill in any missing email or mobile via Cognism (then Lusha).
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status banner
// ---------------------------------------------------------------------------

function StatusBanner({ status, error }) {
  if (error) return <Banner tone="danger" icon={Icon.AlertTriangle}>{error}</Banner>;
  if (!status) return <Banner tone="muted" icon={Icon.Loader}>Checking integrations…</Banner>;

  const { ready, missing = [], pomanda_configured, cognism_configured, lusha_configured } = status;
  if (ready) {
    return (
      <Banner tone="success" icon={Icon.CheckCircle2}>
        Ready — Pomanda, Cognism, and Lusha are all configured. Full verify + enrich available.
      </Banner>
    );
  }
  const configuredCount = [pomanda_configured, cognism_configured, lusha_configured].filter(Boolean).length;
  const tone = configuredCount === 0 ? "info" : "warning";
  const headline = configuredCount === 0
    ? "No credentials configured. You can still upload — results will show Zint data as-is."
    : `${configuredCount} of 3 tools configured. Missing: ${missing.join(", ")}.`;
  return (
    <Banner tone={tone} icon={Icon.AlertTriangle}>
      <div>
        <div style={{ fontWeight: 500 }}>{headline}</div>
        <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 4 }}>
          Add keys in the Connections tab. Without them, Zint-provided MAN + contact are preserved
          and flagged "As-Is" (unverified) in results.
        </div>
      </div>
    </Banner>
  );
}

function Banner({ tone, icon: IconCmp, children }) {
  const tones = {
    success: { bg: "var(--green-soft)", border: "var(--green)", fg: "var(--green)" },
    warning: { bg: "rgba(180,67,44,0.06)", border: "rgba(180,67,44,0.35)", fg: "var(--danger)" },
    danger: { bg: "rgba(180,67,44,0.08)", border: "var(--danger)", fg: "var(--danger)" },
    info: { bg: "var(--accent-soft)", border: "var(--accent-line)", fg: "var(--accent)" },
    muted: { bg: "var(--bg-soft)", border: "var(--border)", fg: "var(--fg-muted)" },
  };
  const t = tones[tone] || tones.muted;
  return (
    <div
      className="flex items-start gap-3 mb-6"
      style={{ border: `1px solid ${t.border}`, background: t.bg, borderRadius: 10, padding: "12px 14px" }}
      role="status"
    >
      {IconCmp && <IconCmp className="lucide-sm" style={{ color: t.fg, marginTop: 2, flexShrink: 0 }} />}
      <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.5, flex: 1 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload zone
// ---------------------------------------------------------------------------

function UploadSection({
  onFile, uploading, uploadError, uploadWarning, uploadedFilename,
  hasLeads, onReset, columnMapping, extraColumns,
}) {
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef(null);

  const onDrop = (e) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  };
  const onPick = (e) => {
    const f = e.target.files?.[0];
    if (f) onFile(f);
    e.target.value = "";
  };

  return (
    <section className="mb-6">
      <SectionLabel>Upload a CSV</SectionLabel>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
        style={{
          border: hasLeads
            ? "1px solid var(--border)"
            : `${dragActive ? 2 : 1}px dashed ${dragActive ? "var(--accent)" : "var(--border-strong)"}`,
          borderRadius: 12,
          padding: hasLeads ? 16 : 32,
          background: hasLeads ? "var(--bg-elev)" : (dragActive ? "var(--accent-soft)" : "var(--bg-elev)"),
          textAlign: "center",
          transition: "all 120ms ease",
        }}
      >
        {hasLeads ? (
          <div className="flex items-center justify-between" style={{ gap: 12 }}>
            <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
              <Icon.FileText className="lucide-sm" style={{ color: "var(--fg-muted)", flexShrink: 0 }} />
              <div style={{ minWidth: 0, textAlign: "left" }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {uploadedFilename || "Uploaded CSV"}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>
                  Upload another file to replace the current batch.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }} onClick={() => inputRef.current?.click()}>
                Choose different file
              </button>
              <button className="btn-ghost px-3 py-1.5" style={{ fontSize: 13, color: "var(--fg-muted)" }} onClick={onReset}>
                Clear
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center" style={{ gap: 10 }}>
            <Icon.Upload className="lucide" style={{ color: dragActive ? "var(--accent)" : "var(--fg-muted)", width: 32, height: 32 }} />
            <div style={{ fontSize: 15, fontWeight: 500, color: "var(--fg)" }}>
              {uploading ? "Parsing…" : "Drop a Zint CSV here"}
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
              or{" "}
              <button
                type="button"
                className="btn-ghost"
                style={{ fontSize: 13, color: "var(--accent)", padding: "2px 6px" }}
                onClick={() => inputRef.current?.click()}
              >
                browse for a file
              </button>
              {"  ·  up to "}{MAX_LEADS}{" leads per batch"}
            </div>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={onPick}
          aria-label="Upload CSV file"
        />
      </div>
      {uploadError && <div className="mt-3" style={{ fontSize: 13, color: "var(--danger)" }}>{uploadError}</div>}
      {uploadWarning && <div className="mt-3" style={{ fontSize: 13, color: "var(--fg-muted)" }}>{uploadWarning}</div>}
      {hasLeads && Object.keys(columnMapping || {}).length > 0 && (
        <ColumnMappingPreview mapping={columnMapping} extraColumns={extraColumns} />
      )}
    </section>
  );
}

function ColumnMappingPreview({ mapping, extraColumns }) {
  const mapped = Object.entries(mapping);
  if (!mapped.length) return null;
  return (
    <div className="mt-3" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
      <span style={{ fontWeight: 500, color: "var(--fg-muted)" }}>Detected columns: </span>
      {mapped.map(([schema, header], i) => (
        <span key={schema}>
          <span style={{ fontFamily: "Menlo, Courier, monospace", color: "var(--fg)" }}>{header}</span>
          <span style={{ color: "var(--fg-faint)" }}>→</span>
          <span style={{ color: "var(--accent)" }}>{schema}</span>
          {i < mapped.length - 1 ? ", " : ""}
        </span>
      ))}
      {extraColumns?.length ? (
        <span>
          {" · "}
          <span style={{ color: "var(--fg-faint)" }}>{extraColumns.length} extra column{extraColumns.length === 1 ? "" : "s"} preserved for export</span>
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leads preview + results table
// ---------------------------------------------------------------------------

function LeadsTable({ leads, selectedIdx, setSelectedIdx, results, processing }) {
  const [expanded, setExpanded] = useState(new Set());

  const toggleAll = () => {
    if (selectedIdx.size === leads.length) setSelectedIdx(new Set());
    else setSelectedIdx(new Set(leads.map((_, i) => i)));
  };
  const toggleOne = (i) => {
    setSelectedIdx((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };
  const toggleExpand = (i) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  // Match results to leads by position (backend preserves order).
  const resultByIdx = useMemo(() => {
    if (!results?.results) return {};
    const m = {};
    results.results.forEach((r, i) => { m[i] = r; });
    return m;
  }, [results]);

  const allSelected = selectedIdx.size === leads.length && leads.length > 0;
  const someSelected = selectedIdx.size > 0 && selectedIdx.size < leads.length;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <SectionLabel>Leads ({leads.length})</SectionLabel>
        <div className="flex items-center gap-3" style={{ fontSize: 13 }}>
          <span style={{ color: "var(--fg-muted)" }}>{selectedIdx.size} selected</span>
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            style={{ fontSize: 13, color: "var(--accent)" }}
            onClick={toggleAll}
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-elev)", overflow: "hidden" }}>
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: "36px minmax(180px, 1.6fr) minmax(140px, 1fr) minmax(180px, 1.4fr) minmax(140px, 1fr) 160px 24px",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--fg-faint)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          <div>
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected; }}
              onChange={toggleAll}
              aria-label="Select all leads"
              disabled={processing}
            />
          </div>
          <div>Company</div>
          <div>MAN</div>
          <div>Email</div>
          <div>Mobile</div>
          <div>Status</div>
          <div />
        </div>

        {leads.map((lead, i) => (
          <LeadRow
            key={i}
            lead={lead}
            checked={selectedIdx.has(i)}
            onToggle={() => toggleOne(i)}
            disabled={processing}
            result={resultByIdx[i]}
            isLast={i === leads.length - 1}
            isExpanded={expanded.has(i)}
            onExpand={() => toggleExpand(i)}
          />
        ))}
      </div>
    </section>
  );
}

function _fullName(lead) {
  const parts = [(lead?.first_name || "").trim(), (lead?.last_name || "").trim()].filter(Boolean);
  return parts.join(" ");
}

function LeadRow({ lead, checked, onToggle, disabled, result, isLast, isExpanded, onExpand }) {
  const hasResult = Boolean(result);
  const rowMan = result?.man || null;
  // Show result MAN when available, else show Zint's candidate from the preview.
  const displayName = rowMan?.name || _fullName(lead) || "—";
  const displayTitle = rowMan?.job_title || rowMan?.role || lead?.job_title || "";
  const displayEmail = rowMan?.email || lead?.email || "";
  const displayMobile = rowMan?.mobile || lead?.mobile || "";

  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "36px minmax(180px, 1.6fr) minmax(140px, 1fr) minmax(180px, 1.4fr) minmax(140px, 1fr) 160px 24px",
          padding: "10px 14px",
          fontSize: 13,
          cursor: hasResult ? "pointer" : "default",
        }}
        onClick={(e) => {
          if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
          if (hasResult) onExpand();
        }}
      >
        <div>
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            disabled={disabled}
            aria-label={`Select ${lead.name}`}
          />
        </div>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lead.name}</div>
          {lead.domain && (
            <div style={{ fontSize: 11, color: "var(--fg-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {lead.domain}
            </div>
          )}
        </div>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <div style={{ color: displayName === "—" ? "var(--fg-faint)" : "var(--fg)" }}>{displayName}</div>
          {displayTitle && (
            <div style={{ fontSize: 11, color: "var(--fg-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {displayTitle}
            </div>
          )}
        </div>
        <div style={{ fontFamily: "Menlo, Courier, monospace", fontSize: 12, color: displayEmail ? "var(--fg-muted)" : "var(--fg-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayEmail || "—"}
        </div>
        <div style={{ fontFamily: "Menlo, Courier, monospace", fontSize: 12, color: displayMobile ? "var(--fg-muted)" : "var(--fg-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayMobile || "—"}
        </div>
        <div>
          <StatusBadge result={result} />
        </div>
        <div style={{ color: "var(--fg-faint)" }}>
          {hasResult && (isExpanded ? <Icon.ChevronDown className="lucide-xs" /> : <Icon.ChevronRight className="lucide-xs" />)}
        </div>
      </div>
      {hasResult && isExpanded && (
        <div
          className="slide-in-top"
          style={{ padding: "10px 14px 14px 50px", borderTop: "1px solid var(--border)", background: "var(--bg)" }}
        >
          <LeadResultDetail result={result} lead={lead} />
        </div>
      )}
    </div>
  );
}

// Map backend (status, enrichment_status) into the UI badge.
function _resolveBadge(result) {
  if (!result) return null;
  if (result.status === "error") return { key: "error", label: "Error", bg: "rgba(180,67,44,0.08)", fg: "var(--danger)" };
  if (result.status === "needs_review") return { key: "needs_review", label: "Needs review", bg: "var(--accent-soft)", fg: "var(--accent)" };
  if (result.status === "partial") return { key: "partial", label: "Partial", bg: "rgba(180,67,44,0.06)", fg: "var(--danger)" };

  // status === "success" — disambiguate by enrichment/contact status.
  const es = result.enrichment_status;
  const cs = result.contact_status;
  if (es === "man_upgraded") return { key: "upgraded", label: "Upgraded", bg: "var(--accent-soft)", fg: "var(--accent)" };
  if (es === "man_from_zint_unverified" && cs === "contact_from_zint") return { key: "as_is", label: "As-Is", bg: "var(--bg-soft)", fg: "var(--fg-muted)" };
  if (cs === "contact_enriched_cognism" || cs === "contact_enriched_lusha") return { key: "enriched", label: "Enriched", bg: "var(--green-soft)", fg: "var(--green)" };
  if (es === "man_verified") return { key: "verified", label: "Verified", bg: "var(--green-soft)", fg: "var(--green)" };
  return { key: "success", label: "Success", bg: "var(--green-soft)", fg: "var(--green)" };
}

function StatusBadge({ result }) {
  const b = _resolveBadge(result);
  if (!b) return <span style={{ fontSize: 12, color: "var(--fg-faint)" }}>—</span>;
  return (
    <span
      style={{
        display: "inline-block", padding: "2px 10px", borderRadius: 999,
        fontSize: 11, fontWeight: 500, background: b.bg, color: b.fg, letterSpacing: "0.02em",
      }}
      aria-label={b.label}
    >
      {b.label}
    </span>
  );
}

function SourceTag({ source }) {
  if (!source) return null;
  const map = {
    zint: { label: "Zint", fg: "var(--fg-muted)" },
    pomanda: { label: "verified by Pomanda", fg: "var(--green)" },
    upgraded: { label: "upgraded via Pomanda", fg: "var(--accent)" },
    cognism: { label: "Cognism", fg: "var(--accent)" },
    lusha: { label: "Lusha", fg: "var(--accent)" },
  };
  const m = map[source] || { label: source, fg: "var(--fg-muted)" };
  return (
    <span style={{ fontSize: 11, color: m.fg, fontWeight: 500, letterSpacing: "0.02em", marginLeft: 8 }}>
      [{m.label}]
    </span>
  );
}

function LeadResultDetail({ result, lead }) {
  const status = result?.status;
  const man = result?.man || {};
  const sources = result?.sources || {};

  if (status === "needs_review") {
    return (
      <div className="flex flex-col gap-2">
        <DetailRow label="Parent" value={man.parent_company || "—"} />
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Rule 2 hit — {man.parent_company || "the parent company"} is the majority shareholder.
          Look up its largest private shareholder manually.
        </div>
      </div>
    );
  }
  if (status === "error") {
    return <div style={{ fontSize: 13, color: "var(--danger)" }}>{result?.error || "Unknown error."}</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <DetailRow
        label="MAN"
        value={man.name || _fullName(lead) || "—"}
        suffix={<>
          {(man.job_title || man.role) && (
            <span style={{ color: "var(--fg-muted)" }}> · {man.job_title || man.role}</span>
          )}
          {typeof man.shareholder_pct === "number" && (
            <span style={{ color: "var(--fg-muted)" }}> · {man.shareholder_pct}%</span>
          )}
          <SourceTag source={sources.man} />
        </>}
      />
      <DetailRow label="Email" value={man.email} mono suffix={<SourceTag source={sources.email} />} />
      <DetailRow label="Mobile" value={man.mobile} mono suffix={<SourceTag source={sources.mobile} />} />
      {(man.linkedin || lead.linkedin) && (
        <DetailRow label="LinkedIn" value={man.linkedin || lead.linkedin} mono />
      )}
      {status === "partial" && (
        <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 4 }}>
          {result?.error || "Contact is incomplete — neither Cognism nor Lusha could complete it."}
        </div>
      )}
      {result?.enrichment_status === "man_from_zint_unverified" && (
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginTop: 2 }}>
          Pomanda not configured — MAN taken from Zint as-is, not verified against Companies House.
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono, emptyLabel, suffix }) {
  return (
    <div className="flex items-baseline" style={{ gap: 12 }}>
      <div
        style={{
          fontSize: 11, color: "var(--fg-faint)", letterSpacing: "0.04em",
          textTransform: "uppercase", width: 72, flexShrink: 0,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? "Menlo, Courier, monospace" : undefined,
          fontSize: mono ? 12.5 : 13,
          color: value ? "var(--fg)" : "var(--fg-faint)",
          flex: 1,
        }}
      >
        {value || emptyLabel || "—"}
        {suffix}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Process bar
// ---------------------------------------------------------------------------

function ProcessBar({ selectedCount, processing, onProcess, processError, progressMessage }) {
  return (
    <section className="mb-6">
      <div
        className="flex items-center justify-between"
        style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-elev)", padding: "14px 16px", gap: 16 }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)" }}>
            {processing ? "Processing…" : `Process ${selectedCount} lead${selectedCount === 1 ? "" : "s"}`}
          </div>
          <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>
            {processing
              ? progressMessage
              : selectedCount === 0
                ? "Select at least one lead to process."
                : "Verify MAN via Pomanda, then fill any missing contact via Cognism → Lusha."}
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ fontSize: 14, padding: "10px 18px", display: "flex", alignItems: "center", gap: 8 }}
          onClick={onProcess}
          disabled={processing || selectedCount === 0}
        >
          {processing ? (<><Icon.Loader className="lucide-sm spin" />Working</>) : (<><Icon.Zap className="lucide-sm" />Run workflow</>)}
        </button>
      </div>
      {processError && <div className="mt-3" style={{ fontSize: 13, color: "var(--danger)" }}>{processError}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Summary bar + CSV export (preserves all original Zint columns)
// ---------------------------------------------------------------------------

function SummaryBar({ results, leads, detectedColumns, onReset }) {
  const summary = results.summary || {};
  const credits = results.credits_used || {};

  // Derive counts by badge type rather than raw status, so the UI stays consistent
  // with what LeadRow shows.
  const counts = useMemo(() => {
    const c = { verified: 0, upgraded: 0, enriched: 0, as_is: 0, partial: 0, error: 0, needs_review: 0 };
    for (const r of results.results || []) {
      const b = _resolveBadge(r);
      if (b && c[b.key] !== undefined) c[b.key] += 1;
    }
    return c;
  }, [results]);

  const downloadCsv = () => {
    // Preserve original Zint columns first, then append enrichment columns.
    const originalCols = detectedColumns || [];
    const enrichmentCols = [
      "verified_man_name", "verified_man_title", "verified_email", "verified_mobile",
      "man_source", "email_source", "mobile_source",
      "enrichment_status", "contact_status", "status",
      "credits_cognism_used", "credits_lusha_used",
      "notes",
    ];

    const lines = [[...originalCols, ...enrichmentCols].map(csvEscape).join(",")];
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      const r = (results.results || [])[i];
      const original = lead.original_row || {};
      const man = r?.man || {};
      const sources = r?.sources || {};
      const cu = r?.credits_used || {};

      const originalValues = originalCols.map((col) => csvEscape(original[col] ?? ""));
      const enrichmentValues = [
        csvEscape(man.name || ""),
        csvEscape(man.job_title || man.role || ""),
        csvEscape(man.email || ""),
        csvEscape(man.mobile || ""),
        csvEscape(sources.man || ""),
        csvEscape(sources.email || ""),
        csvEscape(sources.mobile || ""),
        csvEscape(r?.enrichment_status || ""),
        csvEscape(r?.contact_status || ""),
        csvEscape(r?.status || "missing"),
        csvEscape(cu.cognism || 0),
        csvEscape(cu.lusha || 0),
        csvEscape(r?.error || ""),
      ];
      lines.push([...originalValues, ...enrichmentValues].join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    a.download = `man-results-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <section className="mb-6">
      <div style={{ border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-elev)", padding: "14px 16px" }}>
        <div className="flex items-center justify-between flex-wrap" style={{ gap: 16 }}>
          <div className="flex items-center flex-wrap" style={{ gap: 16 }}>
            <SummaryChip label="Verified" value={counts.verified} tone="success" />
            <SummaryChip label="Upgraded" value={counts.upgraded} tone="info" />
            <SummaryChip label="Enriched" value={counts.enriched} tone="success" />
            <SummaryChip label="As-Is" value={counts.as_is} tone="muted" />
            <SummaryChip label="Partial" value={counts.partial} tone="warning" />
            <SummaryChip label="Errors" value={counts.error} tone="danger" />
            {counts.needs_review > 0 && <SummaryChip label="Needs review" value={counts.needs_review} tone="info" />}
          </div>
          <div className="flex items-center" style={{ gap: 8 }}>
            <button
              className="btn-secondary"
              style={{ fontSize: 13, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}
              onClick={downloadCsv}
            >
              <Icon.Download className="lucide-sm" />
              Download CSV
            </button>
            <button
              className="btn-ghost"
              style={{ fontSize: 13, padding: "8px 14px", color: "var(--fg-muted)" }}
              onClick={onReset}
            >
              Start new batch
            </button>
          </div>
        </div>
        <div
          className="mt-3 flex items-center flex-wrap"
          style={{ gap: 16, fontSize: 12, color: "var(--fg-muted)", paddingTop: 12, borderTop: "1px solid var(--border)" }}
        >
          <span>Credits used</span>
          <span style={{ fontFamily: "Menlo, Courier, monospace" }}>
            Cognism: {credits.cognism || 0} · Lusha: {credits.lusha || 0}
          </span>
          {results.truncated && (
            <span style={{ color: "var(--danger)" }}>
              · Batch truncated from {results.original_count} to {results.total}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function SummaryChip({ label, value, tone }) {
  const colors = {
    success: "var(--green)",
    warning: "var(--danger)",
    muted: "var(--fg-muted)",
    info: "var(--accent)",
    danger: "var(--danger)",
  };
  return (
    <div className="flex items-baseline" style={{ gap: 6 }}>
      <span style={{ fontSize: 18, fontWeight: 500, color: colors[tone] || "var(--fg)" }}>
        {value}
      </span>
      <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 11, color: "var(--fg-faint)", letterSpacing: "0.04em",
        textTransform: "uppercase", fontWeight: 500,
      }}
    >
      {children}
    </div>
  );
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
