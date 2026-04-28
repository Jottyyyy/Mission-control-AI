import React, { useMemo, useState, memo } from 'react';
import {
  formatFriendlyTime,
  formatFriendlyDate,
  formatRelativeTime,
  formatFileSize,
  dayBucket,
  formatTimeOnly,
  formatDuration,
  groupByPeriod,
  dayHeaderLabel,
  isLocalToday,
} from './utils/datetime.js';

// All exported card components are wrapped in React.memo at the bottom of
// this file. Combined with the JSON.parse cache in markdown.jsx, that
// short-circuits re-renders triggered by unrelated parent state changes
// (typing in chat, scroll position, etc.) — the previous v1.24 behaviour
// rebuilt every grouping bucket on every keystroke, which read as flicker
// even though the final DOM was unchanged.

// v1.23 — inline rendering for Google Workspace read actions.
//
// Backend (server.py) emits a fenced JSON payload (e.g. ```google-calendar-events
// {...} ```). markdown.jsx detects the language tag and routes the parsed JSON
// to one of the components below. Each component owns its own visual layout
// and is otherwise oblivious to chat plumbing — props are just `{ data }`.

// --- Shared visual primitives ---------------------------------------------

const CARD_STYLE = {
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: "12px 14px",
  margin: "8px 0",
  boxShadow: "0 1px 2px rgba(28,28,26,0.04)",
};

const CARD_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
  paddingBottom: 8,
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--fg)",
};

const ROW_STYLE = {
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
};

const MUTED_STYLE = { color: "var(--fg-muted)", fontSize: 12 };
const FAINT_STYLE = { color: "var(--fg-faint)", fontSize: 11 };

const PILL_STYLE = {
  display: "inline-block",
  fontSize: 11,
  padding: "1px 7px",
  borderRadius: 999,
  background: "var(--bg-soft)",
  color: "var(--fg-muted)",
  marginRight: 4,
};

const LINK_STYLE = {
  color: "var(--accent)",
  textDecoration: "none",
};

const ID_STYLE = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  color: "var(--fg-faint)",
  opacity: 0,
  transition: "opacity 120ms",
};

function CardShell({ title, count, action, children }) {
  return (
    <div style={CARD_STYLE}>
      <div style={CARD_HEADER_STYLE}>
        <span>
          {title}
          {typeof count === "number" && (
            <span style={{ color: "var(--fg-muted)", fontWeight: 500 }}>
              {" — "}
              {count} {count === 1 ? "result" : "results"}
            </span>
          )}
        </span>
        {action || null}
      </div>
      {children}
    </div>
  );
}

function EmptyState({ icon, message }) {
  return (
    <div style={{
      padding: "16px 4px",
      textAlign: "center",
      color: "var(--fg-muted)",
      fontSize: 13,
    }}>
      <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
      <div>{message}</div>
    </div>
  );
}

function HoverableRow({ href, children, ariaLabel }) {
  // Row reveals the trailing ID on hover; click opens the html_link/web_link
  // in the user's browser. Fully keyboard-accessible — Enter/Space activates.
  const [hover, setHover] = useState(false);
  const interactive = !!href;
  const handleClick = (e) => {
    if (!interactive) return;
    e.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
  };
  const handleKey = (e) => {
    if (interactive && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      window.open(href, "_blank", "noopener,noreferrer");
    }
  };
  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKey}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={interactive ? 0 : -1}
      role={interactive ? "link" : undefined}
      aria-label={ariaLabel}
      style={{
        ...ROW_STYLE,
        cursor: interactive ? "pointer" : "default",
        background: hover && interactive ? "var(--accent-soft)" : "transparent",
        borderRadius: 6,
        marginLeft: -6,
        marginRight: -6,
        paddingLeft: 6,
        paddingRight: 6,
        outline: "none",
        // Subtle focus ring that respects accent.
        boxShadow: hover && interactive ? "0 0 0 1px var(--accent-line)" : "none",
      }}
    >
      <div data-row-hover={hover ? "1" : "0"} style={{ "--id-opacity": hover ? 0.7 : 0 }}>
        {React.Children.map(children, (c) => c)}
      </div>
    </div>
  );
}

function FaintId({ id, hover }) {
  if (!id) return null;
  return (
    <span style={{
      ...ID_STYLE,
      opacity: hover ? 0.7 : 0,
      marginLeft: 6,
    }}>
      {String(id).slice(0, 8)}
    </span>
  );
}

// --- Calendar -------------------------------------------------------------

function nameFromAttendee(a) {
  if (!a || typeof a !== "object") return "";
  if (a.display_name) return a.display_name;
  const e = a.email || "";
  const local = e.split("@")[0] || "";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ") || e;
}

// Lifecycle relative to "now": past events get dimmed, current events get
// a 🔴 Now badge, future events render normally. v1.25 only applies the
// dim/now treatment when the event is on today's local date — for tomorrow
// or future days, "past" doesn't make sense yet, so leave them un-dimmed.
function eventStatus(ev) {
  if (ev.all_day) return "future";
  if (!isLocalToday(ev.start)) return "future";
  const start = new Date(ev.start).getTime();
  const end = new Date(ev.end).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "future";
  const now = Date.now();
  if (now < start) return "future";
  if (now >= start && now <= end) return "now";
  return "past";
}

const NOW_PILL_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  padding: "1px 6px",
  borderRadius: 999,
  background: "var(--danger)",
  color: "white",
  textTransform: "uppercase",
};

function NowPill() {
  return <span style={NOW_PILL_STYLE}>● Now</span>;
}

function CalendarEventRow({ ev, compact }) {
  const [hover, setHover] = useState(false);
  const status = eventStatus(ev);
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const visible = attendees.slice(0, 3);
  const extra = attendees.length - visible.length;
  const tooltip = attendees.map(nameFromAttendee).filter(Boolean).join(", ");
  const timeLabel = ev.all_day
    ? "All day"
    : `${formatTimeOnly(ev.start)} – ${formatTimeOnly(ev.end)}`;
  const dim = status === "past" ? 0.6 : 1;
  const open = () => ev.html_link && window.open(ev.html_link, "_blank", "noopener,noreferrer");
  return (
    <div
      onClick={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={ev.html_link ? 0 : -1}
      role={ev.html_link ? "link" : undefined}
      onKeyDown={(e) => {
        if (ev.html_link && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
      style={{
        ...ROW_STYLE,
        opacity: dim,
        cursor: ev.html_link ? "pointer" : "default",
        background: hover && ev.html_link ? "var(--accent-soft)" : "transparent",
        borderRadius: 6,
        marginLeft: -6,
        marginRight: -6,
        paddingLeft: 6,
        paddingRight: 6,
        outline: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        {status === "now" && <NowPill />}
        <div style={{
          fontWeight: 600,
          fontSize: 13.5,
          color: "var(--fg)",
          textDecoration: status === "past" ? "line-through" : "none",
          textDecorationThickness: 1,
        }}>
          {ev.summary || "(untitled event)"}
        </div>
        <div style={MUTED_STYLE}>
          {timeLabel}
          {!ev.all_day && (() => {
            const dur = formatDuration(ev.start, ev.end);
            return dur ? <span style={{ marginLeft: 6, color: "var(--fg-faint)" }}>· {dur}</span> : null;
          })()}
        </div>
        <FaintId id={ev.id} hover={hover} />
      </div>
      {!compact && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 3, flexWrap: "wrap" }}>
          {ev.location && (
            <span style={{ ...PILL_STYLE, background: "var(--accent-soft)", color: "var(--accent)" }}>
              📍 {ev.location}
            </span>
          )}
          {visible.length > 0 && (
            <span style={MUTED_STYLE} title={tooltip}>
              with {visible.map(nameFromAttendee).filter(Boolean).join(", ")}
              {extra > 0 ? ` + ${extra} other${extra === 1 ? "" : "s"}` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const TH_STYLE = {
  textAlign: "left",
  padding: "6px 8px",
  background: "var(--bg-soft)",
  borderBottom: "1px solid var(--border-strong)",
  color: "var(--fg)",
  fontWeight: 600,
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
  zIndex: 1,
};

const TD_STYLE = {
  padding: "6px 8px",
  borderBottom: "1px solid var(--border)",
  color: "var(--fg)",
  verticalAlign: "top",
};

function CalendarTableRow({ ev, striped }) {
  const [hover, setHover] = useState(false);
  const status = eventStatus(ev);
  const dim = status === "past" ? 0.5 : 1;
  const open = () => ev.html_link && window.open(ev.html_link, "_blank", "noopener,noreferrer");
  // Now-row gets the accent-soft background even when striped, so the
  // current event stands out without competing with the zebra stripes.
  const baseBg = status === "now"
    ? "var(--accent-soft)"
    : (striped ? "var(--bg-soft)" : "transparent");
  const bg = hover && ev.html_link
    ? "var(--accent-soft)"
    : baseBg;
  const dur = !ev.all_day ? formatDuration(ev.start, ev.end) : "";
  return (
    <tr
      onClick={open}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(e) => {
        if (ev.html_link && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); }
      }}
      tabIndex={ev.html_link ? 0 : -1}
      style={{
        opacity: dim,
        cursor: ev.html_link ? "pointer" : "default",
        background: bg,
        transition: "background 100ms ease",
      }}
    >
      <td style={{ ...TD_STYLE, whiteSpace: "nowrap", width: 140 }}>
        <div>{ev.all_day ? "All day" : `${formatTimeOnly(ev.start)} – ${formatTimeOnly(ev.end)}`}</div>
        {dur && <div style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 2 }}>{dur}</div>}
      </td>
      <td style={TD_STYLE}>
        {status === "now" && <span style={{ ...NOW_PILL_STYLE, marginRight: 6 }}>● Now</span>}
        <span style={{
          fontWeight: 600,
          textDecoration: status === "past" ? "line-through" : "none",
        }}>
          {ev.summary || "(untitled event)"}
        </span>
        {ev.location && <span style={{ ...MUTED_STYLE, marginLeft: 8 }}>· {ev.location}</span>}
      </td>
    </tr>
  );
}

function CalendarTableView({ events, periods }) {
  // Single source of truth for period dividers — `periods` comes from
  // groupByPeriod() so LIST and TABLE views stay aligned.
  return (
    <table style={{
      borderCollapse: "collapse",
      width: "100%",
      fontSize: 12.5,
      tableLayout: "auto",
    }}>
      <thead>
        <tr>
          <th style={TH_STYLE}>Time</th>
          <th style={TH_STYLE}>Event</th>
        </tr>
      </thead>
      <tbody>
        {periods.map((period) => {
          const rows = [];
          rows.push(
            <tr key={`hdr-${period.key}`} style={{ background: "var(--bg-soft)" }}>
              <td colSpan={2} style={{
                padding: "6px 8px",
                borderTop: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                color: "var(--fg-muted)",
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}>
                {period.label}
                {period.range && <span style={{ color: "var(--fg-faint)", fontWeight: 500, marginLeft: 8 }}>{period.range}</span>}
                <span style={{ color: "var(--fg-faint)", fontWeight: 500, marginLeft: 8 }}>
                  · {period.events.length} event{period.events.length === 1 ? "" : "s"}
                </span>
              </td>
            </tr>
          );
          period.events.forEach((ev, i) => {
            rows.push(
              <CalendarTableRow
                key={ev.id || `${period.key}-${ev.start}-${i}`}
                ev={ev}
                striped={i % 2 === 1}
              />
            );
          });
          return rows;
        })}
      </tbody>
    </table>
  );
}

function ViewToggle({ value, onChange }) {
  const btn = (key, label) => {
    const active = value === key;
    return (
      <button
        type="button"
        onClick={() => onChange(key)}
        style={{
          fontSize: 11,
          padding: "2px 8px",
          background: active ? "var(--accent-soft)" : "transparent",
          border: `1px solid ${active ? "var(--accent-line)" : "var(--border)"}`,
          color: active ? "var(--accent)" : "var(--fg-muted)",
          fontWeight: active ? 600 : 500,
          cursor: "pointer",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
        aria-pressed={active}
      >
        {label}
      </button>
    );
  };
  return (
    <span style={{ display: "inline-flex", gap: 0, borderRadius: 6, overflow: "hidden" }}>
      {btn("list", "List")}
      {btn("table", "Table")}
    </span>
  );
}

function DayHeaderStrip({ dateInput, count }) {
  const label = dayHeaderLabel(dateInput);
  if (!label) return null;
  return (
    <div style={{
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 10,
      padding: "0 0 8px",
      marginBottom: 4,
      borderBottom: "1px dashed var(--border)",
    }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{label.primary}</span>
        {label.secondary && (
          <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>· {label.secondary}</span>
        )}
      </div>
      <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        {count} event{count === 1 ? "" : "s"}
      </span>
    </div>
  );
}

function GoogleCalendarEventsCardImpl({ data }) {
  const [view, setView] = useState("list");
  const events = Array.isArray(data?.events) ? data.events : [];
  // Always render chronologically so period buckets and day groups read
  // correctly regardless of input order.
  const sorted = useMemo(
    () => [...events].sort((a, b) => String(a.start || "").localeCompare(String(b.start || ""))),
    [events],
  );

  // Single-day kicks in when every event lands in the same dayBucket label
  // ("Today", "Tomorrow", a weekday name, or a full date). Multi-day keeps
  // the v1.23 day-grouped flow.
  const singleDay = useMemo(() => {
    if (sorted.length === 0) return true;
    if (sorted.length === 1) return true;
    const first = dayBucket(sorted[0].start);
    return sorted.every((ev) => dayBucket(ev.start) === first);
  }, [sorted]);

  const targetDate = sorted.length ? sorted[0].start : null;

  // Single source of truth for both list and table sections.
  const periods = useMemo(
    () => (singleDay ? groupByPeriod(sorted) : []),
    [singleDay, sorted],
  );

  // Multi-day list grouping (v1.23 behaviour preserved).
  const dayGroups = useMemo(() => {
    if (singleDay) return [];
    const map = new Map();
    for (const ev of sorted) {
      const key = dayBucket(ev.start);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ev);
    }
    return Array.from(map.entries());
  }, [singleDay, sorted]);

  const titleSummary = singleDay && targetDate
    ? `📅 ${dayBucket(targetDate)}`
    : "📅 Your calendar";

  const sectionHeader = (label, range, count) => (
    <div style={{
      ...FAINT_STYLE,
      textTransform: "uppercase",
      letterSpacing: "0.06em",
      padding: "8px 0 2px",
      display: "flex",
      gap: 8,
      alignItems: "baseline",
    }}>
      <span>{label}</span>
      {range && <span style={{ color: "var(--fg-faint)" }}>{range}</span>}
      {typeof count === "number" && (
        <span style={{ color: "var(--fg-faint)" }}>
          · {count} event{count === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );

  return (
    <CardShell
      title={titleSummary}
      count={events.length}
      action={events.length > 1 ? <ViewToggle value={view} onChange={setView} /> : null}
    >
      {events.length === 0 ? (
        <EmptyState icon="📅" message="No events on the calendar." />
      ) : (
        <>
          {singleDay && <DayHeaderStrip dateInput={targetDate} count={events.length} />}
          {view === "table" ? (
            <div style={{ overflowY: "auto", maxHeight: 420, marginLeft: -6, marginRight: -6 }}>
              <CalendarTableView
                events={sorted}
                periods={singleDay
                  ? periods
                  : [{ key: "all", label: "Events", range: "", events: sorted }]}
              />
            </div>
          ) : singleDay ? (
            periods.map((period) => (
              <div key={period.key}>
                {sectionHeader(period.label, period.range, period.events.length)}
                {period.events.map((ev, i) => (
                  <CalendarEventRow key={ev.id || `${period.key}-${ev.start}-${i}`} ev={ev} />
                ))}
              </div>
            ))
          ) : (
            dayGroups.map(([day, evs]) => (
              <div key={day} style={{ marginBottom: 4 }}>
                {sectionHeader(day, "", evs.length)}
                {evs.map((ev, i) => (
                  <CalendarEventRow key={ev.id || `${day}-${ev.start}-${i}`} ev={ev} />
                ))}
              </div>
            ))
          )}
        </>
      )}
    </CardShell>
  );
}

export const GoogleCalendarEventsCard = memo(GoogleCalendarEventsCardImpl);

// --- Gmail list -----------------------------------------------------------

function senderParts(from) {
  if (!from) return { name: "(unknown)", email: "" };
  const m = /^(.*?)\s*<([^>]+)>$/.exec(String(from));
  if (m) return { name: m[1].trim().replace(/^"|"$/g, "") || m[2], email: m[2] };
  return { name: String(from), email: "" };
}

function GmailMessageRow({ msg }) {
  const [hover, setHover] = useState(false);
  const sender = senderParts(msg.from);
  const labels = Array.isArray(msg.labels)
    ? msg.labels
    : Array.isArray(msg.label_ids) ? msg.label_ids : [];
  const visibleLabels = labels.filter(
    (l) => !["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "CATEGORY_UPDATES", "CATEGORY_PROMOTIONS"].includes(l) || l === "IMPORTANT"
  ).slice(0, 3);
  const unread = !!msg.unread || labels.includes("UNREAD");
  const href = msg.id ? `https://mail.google.com/mail/u/0/#inbox/${msg.id}` : null;
  return (
    <div
      onClick={(e) => {
        if (href) {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={href ? 0 : -1}
      role={href ? "link" : undefined}
      onKeyDown={(e) => {
        if (href && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      style={{
        ...ROW_STYLE,
        cursor: href ? "pointer" : "default",
        background: hover && href ? "var(--accent-soft)" : "transparent",
        borderRadius: 6,
        marginLeft: -6,
        marginRight: -6,
        paddingLeft: 6,
        paddingRight: 6,
        outline: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: unread ? "var(--accent)" : "transparent",
          flex: "0 0 auto",
        }} aria-label={unread ? "Unread" : "Read"} />
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{
              fontWeight: unread ? 600 : 500,
              color: "var(--fg)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: "60%",
            }}>
              {sender.name}{" "}
              {sender.email && (
                <span style={{ ...MUTED_STYLE, fontWeight: 400 }}>&lt;{sender.email}&gt;</span>
              )}
            </span>
            <span style={MUTED_STYLE}>{formatFriendlyTime(msg.date)}</span>
          </div>
          <div style={{
            fontWeight: unread ? 600 : 400,
            fontSize: 13,
            color: "var(--fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            marginTop: 1,
          }}>
            {msg.subject || "(no subject)"}
          </div>
          {msg.snippet && (
            <div style={{
              ...MUTED_STYLE,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: 1,
            }}>
              {msg.snippet}
            </div>
          )}
          {visibleLabels.length > 0 && (
            <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {visibleLabels.map((l) => (
                <span key={l} style={PILL_STYLE}>{l.replace(/^Label_/, "").toLowerCase()}</span>
              ))}
            </div>
          )}
        </div>
        <FaintId id={msg.id} hover={hover} />
      </div>
    </div>
  );
}

function GoogleGmailMessagesCardImpl({ data }) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return (
    <CardShell title="📧 Inbox" count={messages.length}>
      {messages.length === 0 ? (
        <EmptyState icon="📭" message="Inbox is clear." />
      ) : (
        messages.map((m, i) => <GmailMessageRow key={m.id || `${m.date}-${i}`} msg={m} />)
      )}
    </CardShell>
  );
}
export const GoogleGmailMessagesCard = memo(GoogleGmailMessagesCardImpl);

// --- Gmail detail ---------------------------------------------------------

function GoogleGmailMessageDetailImpl({ data }) {
  const sender = senderParts(data?.from);
  const href = data?.id ? `https://mail.google.com/mail/u/0/#inbox/${data.id}` : null;
  const headerRow = (label, value) => value ? (
    <div style={{ display: "flex", gap: 10, fontSize: 12.5, padding: "2px 0" }}>
      <span style={{ ...FAINT_STYLE, textTransform: "uppercase", letterSpacing: "0.04em", minWidth: 40 }}>{label}</span>
      <span style={{ color: "var(--fg)", flex: 1 }}>{value}</span>
    </div>
  ) : null;
  return (
    <CardShell
      title="📧 Email"
      action={href ? <a href={href} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>Open in Gmail ↗</a> : null}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg)", marginBottom: 6 }}>
        {data?.subject || "(no subject)"}
      </div>
      <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
        {headerRow("From", sender.name + (sender.email ? ` <${sender.email}>` : ""))}
        {headerRow("To", data?.to)}
        {headerRow("Cc", data?.cc)}
        {headerRow("Date", formatFriendlyTime(data?.date))}
      </div>
      <div style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "10px 12px",
        whiteSpace: "pre-wrap",
        lineHeight: 1.55,
        color: "var(--fg)",
        fontSize: 13,
        maxHeight: 360,
        overflowY: "auto",
      }}>
        {data?.body_text || "(no plain-text body)"}
      </div>
    </CardShell>
  );
}

// --- Drive ---------------------------------------------------------------

const MIME_ICONS = [
  // Specific Google MIME types first.
  [/google-apps\.spreadsheet/, "📊"],
  [/google-apps\.document/, "📝"],
  [/google-apps\.presentation/, "📽️"],
  [/google-apps\.folder/, "📁"],
  [/google-apps\.form/, "📋"],
  [/google-apps\.drawing/, "🖊️"],
  [/^application\/pdf/, "📕"],
  [/^image\//, "🖼️"],
  [/^video\//, "🎬"],
  [/^audio\//, "🎵"],
  [/spreadsheet|excel|csv/, "📊"],
  [/word|document/, "📝"],
  [/zip|tar|gzip|compressed/, "🗜️"],
  [/text\//, "📄"],
];

function iconFor(mime) {
  if (!mime) return "📄";
  for (const [re, icon] of MIME_ICONS) if (re.test(mime)) return icon;
  return "📄";
}

function firstName(s) {
  if (!s) return "";
  return String(s).trim().split(/\s+/)[0];
}

function DriveFileRow({ file }) {
  const [hover, setHover] = useState(false);
  const href = file.web_view_link || file.web_link || null;
  const owner = Array.isArray(file.owners) && file.owners.length
    ? file.owners[0]
    : (file.owner_name ? { name: file.owner_name } : null);
  const ownerLabel = owner ? firstName(owner.name || owner.email) : "";
  return (
    <div
      onClick={(e) => {
        if (href) {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      tabIndex={href ? 0 : -1}
      role={href ? "link" : undefined}
      onKeyDown={(e) => {
        if (href && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
      style={{
        ...ROW_STYLE,
        cursor: href ? "pointer" : "default",
        background: hover && href ? "var(--accent-soft)" : "transparent",
        borderRadius: 6,
        marginLeft: -6,
        marginRight: -6,
        paddingLeft: 6,
        paddingRight: 6,
        outline: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      <span style={{ fontSize: 18, flex: "0 0 auto" }} aria-hidden="true">
        {iconFor(file.mime_type)}
      </span>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <div style={{
          fontWeight: 600,
          fontSize: 13.5,
          color: "var(--fg)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>
          {file.name || "(unnamed)"}
        </div>
        <div style={{ ...MUTED_STYLE, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {file.size != null && <span>{formatFileSize(file.size)}</span>}
          {file.modified && <span>· {formatRelativeTime(file.modified)}</span>}
          {!file.modified && file.modified_time && <span>· {formatRelativeTime(file.modified_time)}</span>}
          {ownerLabel && <span>· {ownerLabel}</span>}
        </div>
      </div>
      <FaintId id={file.id} hover={hover} />
    </div>
  );
}

function GoogleDriveFilesCardImpl({ data }) {
  const files = Array.isArray(data?.files) ? data.files : [];
  const titleSuffix = data?.query ? ` matching "${data.query}"` : "";
  return (
    <CardShell title={`📁 Drive${titleSuffix}`} count={files.length}>
      {files.length === 0 ? (
        <EmptyState icon="📁" message="No matching files." />
      ) : (
        files.map((f, i) => <DriveFileRow key={f.id || `${f.name}-${i}`} file={f} />)
      )}
    </CardShell>
  );
}
export const GoogleDriveFilesCard = memo(GoogleDriveFilesCardImpl);

// --- Sheets ---------------------------------------------------------------

function GoogleSheetsDataCardImpl({ data }) {
  const values = Array.isArray(data?.values) ? data.values : [];
  const range = data?.range || "(no range)";
  const sid = data?.spreadsheet_id;
  const href = sid ? `https://docs.google.com/spreadsheets/d/${sid}/edit` : null;
  const head = values[0] || [];
  const body = values.slice(1);
  const cols = Math.max(head.length, ...body.map((r) => r.length || 0), 1);
  const padded = (row) => Array.from({ length: cols }, (_, i) => row[i] != null ? String(row[i]) : "");

  return (
    <CardShell
      title={`📊 Sheet`}
      action={
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ ...MUTED_STYLE, fontWeight: 500 }}>{range}</span>
          {href && <a href={href} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>Open in Sheets ↗</a>}
        </span>
      }
    >
      {values.length === 0 ? (
        <EmptyState icon="📊" message="The sheet range is empty." />
      ) : (
        <div style={{ overflowX: "auto", marginLeft: -6, marginRight: -6 }}>
          <table style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: 12.5,
            tableLayout: "auto",
          }}>
            <thead>
              <tr>
                {padded(head).map((c, i) => (
                  <th key={i} style={{
                    textAlign: "left",
                    padding: "6px 8px",
                    background: "var(--bg-soft)",
                    borderBottom: "1px solid var(--border-strong)",
                    color: "var(--fg)",
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                  }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri} style={{
                  background: ri % 2 === 0 ? "transparent" : "var(--bg-soft)",
                }}>
                  {padded(row).map((c, ci) => (
                    <td key={ci} style={{
                      padding: "6px 8px",
                      borderBottom: "1px solid var(--border)",
                      color: "var(--fg)",
                      verticalAlign: "top",
                      whiteSpace: "pre-wrap",
                    }}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardShell>
  );
}

// --- Docs -----------------------------------------------------------------

function GoogleDocsContentCardImpl({ data }) {
  const id = data?.id || data?.doc_id;
  const href = id ? `https://docs.google.com/document/d/${id}/edit` : (data?.url || null);
  const wordCount = typeof data?.word_count === "number"
    ? data.word_count
    : (data?.content ? String(data.content).trim().split(/\s+/).filter(Boolean).length : 0);
  const subtitleBits = [];
  if (wordCount) subtitleBits.push(`${wordCount.toLocaleString()} words`);
  if (data?.modified) subtitleBits.push(`modified ${formatRelativeTime(data.modified)}`);
  return (
    <CardShell
      title={`📝 ${data?.title || "(untitled)"}`}
    >
      {subtitleBits.length > 0 && (
        <div style={{ ...MUTED_STYLE, marginTop: -4, marginBottom: 8 }}>
          {subtitleBits.join(" · ")}
        </div>
      )}
      {data?.content ? (
        <div style={{
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "10px 12px",
          whiteSpace: "pre-wrap",
          lineHeight: 1.55,
          color: "var(--fg)",
          fontSize: 13,
          maxHeight: 400,
          overflowY: "auto",
        }}>
          {data.content}
        </div>
      ) : (
        <EmptyState icon="📝" message="The doc is empty." />
      )}
      {href && (
        <div style={{ marginTop: 8, textAlign: "right" }}>
          <a href={href} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
            Open in Google Docs ↗
          </a>
        </div>
      )}
    </CardShell>
  );
}

export const GoogleSheetsDataCard = memo(GoogleSheetsDataCardImpl);
export const GoogleDocsContentCard = memo(GoogleDocsContentCardImpl);
export const GoogleGmailMessageDetail = memo(GoogleGmailMessageDetailImpl);

// --- Fence dispatch -------------------------------------------------------

export const GOOGLE_FENCE_RENDERERS = {
  "google-calendar-events": GoogleCalendarEventsCard,
  "google-gmail-messages": GoogleGmailMessagesCard,
  "google-gmail-message": GoogleGmailMessageDetail,
  "google-drive-files": GoogleDriveFilesCard,
  "google-sheets-data": GoogleSheetsDataCard,
  "google-docs-content": GoogleDocsContentCard,
};
