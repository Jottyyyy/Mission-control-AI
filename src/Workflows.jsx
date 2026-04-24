import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// ---------------------------------------------------------------------------
// MAN workflow UI — Sir Adam's primary daily flow.
//
// Contract with the backend (built in v1.12):
//   GET  /workflow/man/status                    → readiness check
//   POST /workflow/man/upload-spreadsheet        → parse CSV preview
//   POST /workflow/man/process-batch             → run identification + enrich
//
// Design decisions:
//   • Single component. Sections are render-in-order; the state machine is
//     implicit in the presence of {leads, results}.
//   • No streaming in v1 — we POST the batch and show a rotating "what I'm
//     doing now" message while the backend works. 5-minute AbortController.
//   • Spreadsheet upload is JSON-wrapped (FileReader.readAsText then POST
//     {filename, csv_content}) to avoid pulling python-multipart server-side.
// ---------------------------------------------------------------------------

const MAX_LEADS = 200;
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;

const PROGRESS_MESSAGES = [
  "Looking up shareholders on Pomanda…",
  "Applying JSP priority rules…",
  "Enriching contacts with Cognism…",
  "Checking Lusha for missing mobiles…",
  "Reconciling results…",
];

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

export default function Workflows() {
  const [status, setStatus] = useState(null);  // { ready, pomanda_configured, ... } or null
  const [statusError, setStatusError] = useState("");

  const [leads, setLeads] = useState([]);           // [{name, number, website}]
  const [detectedColumns, setDetectedColumns] = useState([]);
  const [selectedIdx, setSelectedIdx] = useState(new Set());
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadedFilename, setUploadedFilename] = useState("");
  const [uploadWarning, setUploadWarning] = useState("");

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [results, setResults] = useState(null);     // full batch response
  const [progressIdx, setProgressIdx] = useState(0);

  const processAbort = useRef(null);

  // Load credential readiness on mount.
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

  // Rotate progress messages while processing.
  useEffect(() => {
    if (!processing) return;
    const id = setInterval(() => {
      setProgressIdx((i) => (i + 1) % PROGRESS_MESSAGES.length);
    }, 2500);
    return () => clearInterval(id);
  }, [processing]);

  // ---------- Upload handlers ----------

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
    setSelectedIdx(new Set());
    setResults(null);
    setUploadError("");
    setUploadWarning("");
    setUploadedFilename("");
    setProcessError("");
  };

  // ---------- Process handlers ----------

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
        />
        {leads.length > 0 && (
          <LeadsTable
            leads={leads}
            detectedColumns={detectedColumns}
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
        Upload a Zint lead batch. For each company we find the Money / Authority / Need
        person and enrich them with a direct email + mobile.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status banner
// ---------------------------------------------------------------------------

function StatusBanner({ status, error }) {
  if (error) {
    return (
      <Banner tone="danger" icon={Icon.AlertTriangle}>
        {error}
      </Banner>
    );
  }
  if (!status) {
    return (
      <Banner tone="muted" icon={Icon.Loader}>
        Checking integrations…
      </Banner>
    );
  }
  const { ready, missing = [], pomanda_configured, cognism_configured, lusha_configured } = status;
  if (ready) {
    return (
      <Banner tone="success" icon={Icon.CheckCircle2}>
        MAN workflow is ready — Pomanda, Cognism, and Lusha are all configured.
      </Banner>
    );
  }
  const configuredCount = [pomanda_configured, cognism_configured, lusha_configured].filter(Boolean).length;
  const tone = configuredCount === 0 ? "info" : "warning";
  const headline = configuredCount === 0
    ? "No credentials configured yet."
    : `${configuredCount} of 3 tools configured. Missing: ${missing.join(", ")}.`;
  return (
    <Banner tone={tone} icon={Icon.AlertTriangle}>
      <div>
        <div style={{ fontWeight: 500 }}>{headline}</div>
        <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 4 }}>
          Add keys for {missing.join(", ")} in the Connections tab. You can still process
          leads to see where things stand — rows without credentials will surface a clear
          "not configured" error.
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
      style={{
        border: `1px solid ${t.border}`,
        background: t.bg,
        borderRadius: 10,
        padding: "12px 14px",
      }}
      role="status"
    >
      {IconCmp && <IconCmp className="lucide-sm" style={{ color: t.fg, marginTop: 2, flexShrink: 0 }} />}
      <div style={{ fontSize: 14, color: "var(--fg)", lineHeight: 1.5, flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload zone
// ---------------------------------------------------------------------------

function UploadSection({ onFile, uploading, uploadError, uploadWarning, uploadedFilename, hasLeads, onReset }) {
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
    e.target.value = "";  // allow re-upload of the same file
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
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {uploadedFilename || "Uploaded CSV"}
                </div>
                <div style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>
                  Upload another file to replace the current batch.
                </div>
              </div>
            </div>
            <button className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }} onClick={() => inputRef.current?.click()}>
              Choose different file
            </button>
            <button className="btn-ghost px-3 py-1.5" style={{ fontSize: 13, color: "var(--fg-muted)" }} onClick={onReset}>
              Clear
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center" style={{ gap: 10 }}>
            <Icon.Upload className="lucide" style={{ color: dragActive ? "var(--accent)" : "var(--fg-muted)", width: 32, height: 32 }} />
            <div style={{ fontSize: 15, fontWeight: 500, color: "var(--fg)" }}>
              {uploading ? "Parsing…" : "Drop a CSV here"}
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
      {uploadError && (
        <div className="mt-3" style={{ fontSize: 13, color: "var(--danger)" }}>
          {uploadError}
        </div>
      )}
      {uploadWarning && (
        <div className="mt-3" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          {uploadWarning}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Leads preview + results table
// ---------------------------------------------------------------------------

function LeadsTable({ leads, detectedColumns, selectedIdx, setSelectedIdx, results, processing }) {
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

  const resultByCompany = useMemo(() => {
    if (!results?.results) return {};
    const map = {};
    for (const r of results.results) {
      map[r.company_name] = r;
    }
    return map;
  }, [results]);

  const allSelected = selectedIdx.size === leads.length && leads.length > 0;
  const someSelected = selectedIdx.size > 0 && selectedIdx.size < leads.length;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
        <SectionLabel>
          Leads ({leads.length}){detectedColumns.length ? ` · columns: ${detectedColumns.join(", ")}` : ""}
        </SectionLabel>
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

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--bg-elev)",
          overflow: "hidden",
        }}
      >
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: "36px minmax(200px, 2fr) 140px 1fr 180px 24px",
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
          <div style={{ fontFamily: "Menlo, Courier, monospace", fontSize: 10 }}>Number</div>
          <div>Website</div>
          <div>Status</div>
          <div />
        </div>

        {leads.map((lead, i) => {
          const result = resultByCompany[lead.name];
          const isExpanded = expanded.has(i);
          return (
            <LeadRow
              key={`${lead.name}-${i}`}
              lead={lead}
              index={i}
              checked={selectedIdx.has(i)}
              onToggle={() => toggleOne(i)}
              disabled={processing}
              result={result}
              isLast={i === leads.length - 1}
              isExpanded={isExpanded}
              onExpand={() => toggleExpand(i)}
            />
          );
        })}
      </div>
    </section>
  );
}

function LeadRow({ lead, index, checked, onToggle, disabled, result, isLast, isExpanded, onExpand }) {
  const hasResult = Boolean(result);
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--border)" }}>
      <div
        className="grid items-center"
        style={{
          gridTemplateColumns: "36px minmax(200px, 2fr) 140px 1fr 180px 24px",
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
          {lead.name}
        </div>
        <div style={{ fontFamily: "Menlo, Courier, monospace", fontSize: 12, color: "var(--fg-muted)" }}>
          {lead.number || "—"}
        </div>
        <div style={{ color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {lead.website || "—"}
        </div>
        <div>
          <StatusBadge status={result?.status} />
        </div>
        <div style={{ color: "var(--fg-faint)" }}>
          {hasResult && (isExpanded ? <Icon.ChevronDown className="lucide-xs" /> : <Icon.ChevronRight className="lucide-xs" />)}
        </div>
      </div>
      {hasResult && isExpanded && (
        <div
          className="slide-in-top"
          style={{
            padding: "10px 14px 14px 50px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          <LeadResultDetail result={result} />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  if (!status) {
    return <span style={{ fontSize: 12, color: "var(--fg-faint)" }}>—</span>;
  }
  const map = {
    success: { label: "Success", bg: "var(--green-soft)", fg: "var(--green)" },
    partial: { label: "Partial", bg: "rgba(180,67,44,0.06)", fg: "var(--danger)" },
    not_found: { label: "Not found", bg: "var(--bg-soft)", fg: "var(--fg-muted)" },
    needs_review: { label: "Needs review", bg: "var(--accent-soft)", fg: "var(--accent)" },
    error: { label: "Error", bg: "rgba(180,67,44,0.08)", fg: "var(--danger)" },
  };
  const m = map[status] || map.error;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        background: m.bg,
        color: m.fg,
        letterSpacing: "0.02em",
      }}
    >
      {m.label}
    </span>
  );
}

function LeadResultDetail({ result }) {
  const status = result?.status;
  const man = result?.man;
  if (status === "success" && man) {
    return (
      <div className="flex flex-col gap-2">
        <DetailRow label="MAN" value={`${man.name}${man.role ? ` · ${man.role}` : ""}`} />
        <DetailRow label="Email" value={man.email} mono />
        <DetailRow label="Mobile" value={man.mobile} mono />
        <DetailRow
          label="Source"
          value={man.source ? man.source[0].toUpperCase() + man.source.slice(1) : null}
        />
      </div>
    );
  }
  if (status === "partial") {
    return (
      <div className="flex flex-col gap-2">
        {man && <DetailRow label="MAN" value={`${man.name || "—"}${man.role ? ` · ${man.role}` : ""}`} />}
        <DetailRow label="Email" value={man?.email} mono emptyLabel="—" />
        <DetailRow label="Mobile" value={man?.mobile} mono emptyLabel="—" />
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          {result.error || "Name found but no complete contact details — try running Lusha manually."}
        </div>
      </div>
    );
  }
  if (status === "needs_review") {
    return (
      <div className="flex flex-col gap-2">
        <DetailRow label="Parent" value={man?.parent_company || "—"} />
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Rule 2 of the JSP priority hit — {man?.parent_company || "the parent company"} is the
          majority shareholder. Look up the largest private shareholder of that parent manually
          to find the real MAN.
        </div>
      </div>
    );
  }
  if (status === "not_found") {
    return (
      <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
        {result.error || "No MAN identifiable from Pomanda data."}
      </div>
    );
  }
  // error
  return (
    <div style={{ fontSize: 13, color: "var(--danger)" }}>
      {result?.error || "Unknown error."}
    </div>
  );
}

function DetailRow({ label, value, mono, emptyLabel }) {
  return (
    <div className="flex items-baseline" style={{ gap: 12 }}>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-faint)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          width: 72,
          flexShrink: 0,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: mono ? "Menlo, Courier, monospace" : undefined,
          fontSize: mono ? 12.5 : 13,
          color: value ? "var(--fg)" : "var(--fg-faint)",
        }}
      >
        {value || emptyLabel || "—"}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Process bar (button + progress spinner)
// ---------------------------------------------------------------------------

function ProcessBar({ selectedCount, processing, onProcess, processError, progressMessage }) {
  return (
    <section className="mb-6">
      <div
        className="flex items-center justify-between"
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--bg-elev)",
          padding: "14px 16px",
          gap: 16,
        }}
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
                : "Runs the Pomanda → Cognism → Lusha cascade for each selected lead."}
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ fontSize: 14, padding: "10px 18px", display: "flex", alignItems: "center", gap: 8 }}
          onClick={onProcess}
          disabled={processing || selectedCount === 0}
        >
          {processing ? (
            <>
              <Icon.Loader className="lucide-sm spin" />
              Working
            </>
          ) : (
            <>
              <Icon.Zap className="lucide-sm" />
              Run workflow
            </>
          )}
        </button>
      </div>
      {processError && (
        <div className="mt-3" style={{ fontSize: 13, color: "var(--danger)" }}>
          {processError}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Summary bar (post-process)
// ---------------------------------------------------------------------------

function SummaryBar({ results, leads, onReset }) {
  const summary = results.summary || {};
  const credits = results.credits_used || {};

  const downloadCsv = () => {
    const lines = [
      ["company_name", "company_number", "website", "man_name", "man_role", "email", "mobile", "source", "status", "notes"].join(","),
    ];
    const byName = new Map();
    for (const r of results.results || []) {
      byName.set(r.company_name, r);
    }
    for (const lead of leads) {
      const r = byName.get(lead.name);
      const m = r?.man || {};
      lines.push([
        csvEscape(lead.name),
        csvEscape(lead.number || r?.company_number || ""),
        csvEscape(lead.website || ""),
        csvEscape(m.name || ""),
        csvEscape(m.role || ""),
        csvEscape(m.email || ""),
        csvEscape(m.mobile || ""),
        csvEscape(m.source || ""),
        csvEscape(r?.status || "missing"),
        csvEscape(r?.error || ""),
      ].join(","));
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
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          background: "var(--bg-elev)",
          padding: "14px 16px",
        }}
      >
        <div className="flex items-center justify-between flex-wrap" style={{ gap: 16 }}>
          <div className="flex items-center flex-wrap" style={{ gap: 16 }}>
            <SummaryChip label="Success" value={summary.success || 0} tone="success" />
            <SummaryChip label="Partial" value={summary.partial || 0} tone="warning" />
            <SummaryChip label="Not found" value={summary.not_found || 0} tone="muted" />
            <SummaryChip label="Needs review" value={summary.needs_review || 0} tone="info" />
            <SummaryChip label="Errors" value={summary.error || 0} tone="danger" />
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
          className="mt-3 flex items-center"
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
// Shared bits
// ---------------------------------------------------------------------------

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: "var(--fg-faint)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        fontWeight: 500,
      }}
    >
      {children}
    </div>
  );
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
