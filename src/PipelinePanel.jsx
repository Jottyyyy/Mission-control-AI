import React, { useState, useEffect, useRef } from 'react';
import Data from './data.jsx';
import Icon from './icons.jsx';

function StepPills({ currentIndex }) {
  return (
    <div className="flex items-center flex-wrap gap-y-2 gap-x-2">
      {Data.pipelineSteps.map((s, i) => {
        const done = i < currentIndex;
        const current = i === currentIndex;
        const cls = done ? "step-pill done" : current ? "step-pill current" : "step-pill pending";
        return (
          <React.Fragment key={s.label}>
            <div className={cls}>
              {done ? <Icon.Check className="lucide-xs" /> : <span style={{ fontSize: 11 }}>{i + 1}.</span>}
              <span>{s.label}</span>
            </div>
            {i < Data.pipelineSteps.length - 1 && (
              <Icon.ChevronRight className="lucide-xs" style={{ color: "var(--fg-faint)", flexShrink: 0 }} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function RunRow({ item, flash }) {
  const isDone = item.status.startsWith("Found") || item.status.startsWith("Got");
  return (
    <div
      className={"flex items-center gap-3 py-2.5 px-3 " + (flash ? "flash-green" : "")}
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <div className="logo-square" style={{ width: 28, height: 28, fontSize: 11 }}>
        {item.company
          .split(" ")
          .slice(0, 2)
          .map((w) => w[0])
          .join("")}
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>
          {item.company}
        </div>
        <div className="truncate" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
          {item.status}
        </div>
      </div>
      {isDone ? (
        <Icon.Check className="lucide-xs" style={{ color: "var(--green)" }} />
      ) : (
        <div className="pulse-dot" style={{ width: 6, height: 6, borderRadius: 999, background: "var(--fg-faint)" }} />
      )}
    </div>
  );
}

function PipelinePanel({
  state,          // "starting" | "running" | "done" | "review"
  setState,
  onClose,
  onMinimize,
}) {
  const hasRunData = Data.pipelineRun.length > 0;
  const hasResults = Data.pipelineResults.length > 0;

  const [feed, setFeed] = useState([]);
  const [flashIds, setFlashIds] = useState(new Set());
  const [count, setCount] = useState(0);
  const feedIdx = useRef(0);

  // Auto-advance through states for the demo (only when seed data is present).
  useEffect(() => {
    if (state !== "starting" || !hasRunData) return;
    const t = setTimeout(() => setState("running"), 2200);
    return () => clearTimeout(t);
  }, [state, hasRunData]);

  useEffect(() => {
    if (state !== "running" || !hasRunData) return;

    setFeed([]);
    setCount(0);
    feedIdx.current = 0;

    const templates = Data.pipelineRun;
    const total = Math.max(templates.length, 50);

    const interval = setInterval(() => {
      feedIdx.current += 1;
      const i = feedIdx.current;
      const tpl = templates[(i - 1) % templates.length];
      const id = "p" + i;
      const item = { id, company: tpl.company, status: tpl.status };

      setFeed((prev) => [item, ...prev].slice(0, 8));
      if (tpl.status.startsWith("Found")) {
        setFlashIds((prev) => {
          const n = new Set(prev);
          n.add(id);
          return n;
        });
        setTimeout(() => {
          setFlashIds((prev) => {
            const n = new Set(prev);
            n.delete(id);
            return n;
          });
        }, 900);
      }
      setCount((c) => Math.min(total, c + 1));

      if (feedIdx.current >= total) {
        clearInterval(interval);
        setTimeout(() => setState("done"), 600);
      }
    }, 280);

    const doneTimer = setTimeout(() => {
      clearInterval(interval);
      setCount(total);
      setState("done");
    }, 14000);

    return () => {
      clearInterval(interval);
      clearTimeout(doneTimer);
    };
  }, [state, hasRunData]);

  const currentStepIdx =
    state === "starting" ? 0 :
    state === "running" ? 1 :
    state === "done" || state === "review" ? 3 :
    0;

  const Header = ({ title }) => (
    <div className="flex items-start justify-between p-5" style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="flex-1 min-w-0 pr-2">
        <div style={{ fontSize: 12, color: "var(--fg-faint)", marginBottom: 2 }}>Marketing pipeline</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--fg)" }}>{title}</div>
      </div>
      <button className="btn-ghost p-1" onClick={onClose} title="Close">
        <Icon.X className="lucide-sm" />
      </button>
    </div>
  );

  // Shared empty state used whenever there is no real pipeline data yet.
  const EmptyBody = () => (
    <div className="flex-1 flex flex-col">
      <div className="p-5" style={{ borderBottom: "1px solid var(--border)" }}>
        <StepPills currentIndex={0} />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div style={{ fontSize: 14, color: "var(--fg)", fontWeight: 500 }}>
          No leads in pipeline yet
        </div>
        <div
          className="mt-2"
          style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55, maxWidth: 240 }}
        >
          Import a batch or start a lead-batch-run skill to begin enrichment.
        </div>
      </div>
      <div className="p-4" style={{ borderTop: "1px solid var(--border)" }}>
        <button className="btn-ghost w-full py-2" style={{ fontSize: 13 }} onClick={onMinimize}>
          Run in background
        </button>
      </div>
    </div>
  );

  const StartingBody = () => (
    <div className="flex-1 flex flex-col">
      <div className="p-5" style={{ borderBottom: "1px solid var(--border)" }}>
        <StepPills currentIndex={0} />
      </div>
      <div className="flex-1 flex flex-col items-center justify-center px-6" style={{ color: "var(--fg-muted)" }}>
        <div className="flex items-center gap-2" style={{ fontSize: 14 }}>
          <span className="pulse-dot" style={{ width: 8, height: 8, borderRadius: 999, background: "var(--fg-faint)", display: "inline-block" }} />
          <span>Starting…</span>
        </div>
        <div className="text-center mt-3" style={{ fontSize: 12, color: "var(--fg-faint)", lineHeight: 1.5, maxWidth: 220 }}>
          Queueing companies from your batch.
        </div>
      </div>
      <div className="p-4" style={{ borderTop: "1px solid var(--border)" }}>
        <button className="btn-ghost w-full py-2" style={{ fontSize: 13 }} onClick={onMinimize}>
          Run in background
        </button>
      </div>
    </div>
  );

  const RunningBody = () => (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="p-5" style={{ borderBottom: "1px solid var(--border)" }}>
        <StepPills currentIndex={1} />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {feed.map((it) => (
          <div key={it.id} className="slide-in-top">
            <RunRow item={it} flash={flashIds.has(it.id)} />
          </div>
        ))}
        {feed.length === 0 && (
          <div className="p-6 text-center" style={{ color: "var(--fg-muted)", fontSize: 13 }}>
            Warming up…
          </div>
        )}
      </div>
      <div
        className="px-5 py-3 flex items-center justify-between"
        style={{ borderTop: "1px solid var(--border)", fontSize: 13 }}
      >
        <span style={{ color: "var(--fg-muted)" }}>
          <span style={{ color: "var(--fg)", fontWeight: 500 }}>{count}</span> processed
        </span>
        <button className="btn-ghost px-2 py-1" style={{ fontSize: 13 }} onClick={onMinimize}>
          Run in background
        </button>
      </div>
    </div>
  );

  const DoneBody = () => (
    <div className="flex-1 flex flex-col">
      <div className="p-5" style={{ borderBottom: "1px solid var(--border)" }}>
        <StepPills currentIndex={3} />
      </div>
      <div className="p-5 flex-1 overflow-y-auto">
        <div className="card p-4">
          <div style={{ fontSize: 13, color: "var(--fg-faint)", marginBottom: 6 }}>Summary</div>
          <div style={{ fontSize: 14, color: "var(--fg-muted)", lineHeight: 1.55 }}>
            Summary will appear here once a real batch completes.
          </div>
        </div>
      </div>
      <div
        className="p-4 flex items-center gap-2"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        <button
          className="btn-primary px-3 py-2 flex-1"
          style={{ fontSize: 13 }}
          onClick={() => setState("review")}
          disabled={!hasResults}
        >
          Review results
        </button>
        <button className="btn-secondary px-3 py-2" style={{ fontSize: 13 }} disabled={!hasResults}>
          <span className="flex items-center gap-1.5">
            <Icon.Download className="lucide-xs" />
            Export CSV
          </span>
        </button>
      </div>
    </div>
  );

  const ReviewBody = () => (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="p-4 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <button className="btn-ghost p-1" onClick={() => setState("done")}>
          <Icon.ArrowLeft className="lucide-sm" />
        </button>
        <div style={{ fontSize: 14, fontWeight: 500 }}>
          {hasResults ? `Results — ${Data.pipelineResults.length} contacts` : "Results"}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {hasResults ? (
          Data.pipelineResults.map((r, i) => (
            <div key={i} style={{ borderBottom: "1px solid var(--border)" }} className="px-4 py-3">
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg)" }}>{r.company}</div>
              <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 2 }}>{r.name}</div>
              <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
                {r.email}{r.phone ? ` · ${r.phone}` : ""}
              </div>
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {r.sources.map((s) => (
                  <span
                    key={s}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--border-strong)",
                      color: "var(--fg-muted)",
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="px-5 py-8 text-center" style={{ fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.55 }}>
            No results yet. Run a batch to see enriched contacts here.
          </div>
        )}
      </div>
    </div>
  );

  // If no real pipeline data exists, show the empty state across all states.
  if (!hasRunData && !hasResults) {
    return (
      <aside
        className="h-full flex flex-col slide-in-right"
        style={{
          width: 320,
          flexShrink: 0,
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        <Header title="Pipeline" />
        <EmptyBody />
      </aside>
    );
  }

  return (
    <aside
      className="h-full flex flex-col slide-in-right"
      style={{
        width: 320,
        flexShrink: 0,
        borderLeft: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      {state === "starting" && <>
        <Header title="Starting batch" />
        <StartingBody />
      </>}
      {state === "running" && <>
        <Header title="Enriching batch" />
        <RunningBody />
      </>}
      {state === "done" && <>
        <Header title="All done" />
        <DoneBody />
      </>}
      {state === "review" && <>
        <Header title="Results" />
        <ReviewBody />
      </>}
    </aside>
  );
}

export default PipelinePanel;
