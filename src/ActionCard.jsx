import React, { useState, useEffect, useRef } from 'react';
import Icon from './icons.jsx';
import { API_BASE } from './SettingsEditor.jsx';

// Marker Jackson's reply carries after /chat post-processing.
// Anchored so a stray `[[action-card:anything]]` deeper in prose still matches,
// but the token shape is strict (uuid-like: hex + dashes).
export const ACTION_CARD_MARKER_RE = /\[\[action-card:([0-9a-fA-F-]{10,})\]\]/g;

function friendlyTime(iso) {
  if (!iso) return "";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Format a calendar event's start/end range for display. start and end are
// ISO 8601 local datetimes (no tz offset); timezone is an optional IANA zone
// used for rendering via Intl so the card matches what Google will save.
// Same-day → "Thu, 24 Apr 2026 · 3:00 pm – 4:00 pm"
// Multi-day → "Thu, 24 Apr 2026 3:00 pm – Fri, 25 Apr 2026 9:00 am"
function formatEventRange(start, end, timezone) {
  if (!start || !end) return "";
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return `${start} – ${end}`;
  }
  const opts = { timeZone: timezone || undefined };
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    ...opts, weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    ...opts, hour: "numeric", minute: "2-digit",
  });
  // Same calendar day in the target timezone? Compare formatted date string.
  const sameDay = dateFmt.format(s) === dateFmt.format(e);
  if (sameDay) {
    return `${dateFmt.format(s)} · ${timeFmt.format(s)} – ${timeFmt.format(e)}`;
  }
  return `${dateFmt.format(s)} ${timeFmt.format(s)} – ${dateFmt.format(e)} ${timeFmt.format(e)}`;
}

function nameFromEmail(email) {
  if (!email || typeof email !== "string") return "";
  const local = email.split("@")[0] || "";
  if (!local) return email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

// --- Gmail card body ------------------------------------------------------
function GmailBody({ data }) {
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <Row label="To"      value={data.to} />
      <Row label="Subject" value={data.subject} />
      <div>
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Body
        </div>
        <div
          style={{
            whiteSpace: "pre-wrap",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            lineHeight: 1.55,
            color: "var(--fg)",
          }}
        >
          {data.body}
        </div>
      </div>
    </div>
  );
}

// --- Calendar event card body --------------------------------------------
function CalendarBody({ data }) {
  const [expanded, setExpanded] = useState(false);
  const attendees = Array.isArray(data.attendees) ? data.attendees : [];
  const shownAttendees = attendees.slice(0, 3);
  const extraAttendees = Math.max(0, attendees.length - shownAttendees.length);
  const desc = (data.description || "").trim();
  const descIsLong = desc.split("\n").length > 3 || desc.length > 220;

  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        {data.summary || "Untitled event"}
      </div>

      <IconLine emoji="🕐" text={formatEventRange(data.start, data.end, data.timezone)} />

      {data.location && <IconLine emoji="📍" text={data.location} />}

      {attendees.length > 0 && (
        <IconLine
          emoji="👥"
          text={
            <span>
              {shownAttendees.map((email, i) => (
                <span key={email}>
                  {i > 0 && ", "}
                  {nameFromEmail(email)}{" "}
                  <span style={{ color: "var(--fg-faint)" }}>({email})</span>
                </span>
              ))}
              {extraAttendees > 0 && (
                <span style={{ color: "var(--fg-muted)" }}> + {extraAttendees} more</span>
              )}
            </span>
          }
        />
      )}

      {desc && (
        <div
          style={{
            fontStyle: "italic",
            color: "var(--fg-muted)",
            marginTop: 4,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: expanded ? "unset" : 3,
            overflow: expanded ? "visible" : "hidden",
          }}
        >
          {desc}
        </div>
      )}
      {desc && descIsLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="btn-ghost"
          style={{ alignSelf: "flex-start", fontSize: 12, color: "var(--fg-muted)", padding: 0 }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}

      {data.timezone && data.timezone !== "Europe/London" && (
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginTop: 2 }}>
          Timezone: {data.timezone}
        </div>
      )}
    </div>
  );
}

function IconLine({ emoji, text }) {
  return (
    <div className="flex gap-2" style={{ alignItems: "baseline" }}>
      <div style={{ width: 18, textAlign: "center", fontSize: 13, lineHeight: 1.4 }}>{emoji}</div>
      <div style={{ flex: 1, lineHeight: 1.4 }}>{text}</div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex gap-3" style={{ alignItems: "baseline" }}>
      <div
        style={{
          width: 62,
          fontSize: 11,
          color: "var(--fg-faint)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, color: "var(--fg)", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

// --- Drive doc card body -------------------------------------------------
const DRIVE_PREVIEW_LINES = 6;

function driveTypeLabel(mime) {
  if (!mime || mime === "application/vnd.google-apps.document") return "Google Doc";
  if (mime === "text/plain") return "Plain text file";
  return mime;
}

function DriveBody({ data }) {
  const [expanded, setExpanded] = useState(false);
  const content = data.content || "";
  const lines = content.split("\n");
  const isLong = lines.length > DRIVE_PREVIEW_LINES;
  const preview = expanded || !isLong
    ? content
    : lines.slice(0, DRIVE_PREVIEW_LINES).join("\n") + "\n…";

  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        {data.name || "Untitled document"}
      </div>

      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Type: {driveTypeLabel(data.mime_type)}
        {data.folder_id && <span> · in folder {data.folder_id}</span>}
      </div>

      <div>
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Preview
        </div>
        {content.trim() ? (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "8px 10px",
              lineHeight: 1.55,
              margin: 0,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
            }}
          >
            {preview}
          </pre>
        ) : (
          <div style={{ fontSize: 12, color: "var(--fg-faint)", fontStyle: "italic" }}>
            (empty document — Adam can fill it in after it's created)
          </div>
        )}
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="btn-ghost"
            style={{ marginTop: 6, fontSize: 12, color: "var(--fg-muted)", padding: 0 }}
          >
            {expanded ? "Show less" : `Show all ${lines.length} lines`}
          </button>
        )}
      </div>
    </div>
  );
}

// --- Contacts card body --------------------------------------------------
function ContactsBody({ data }) {
  const notes = (data.notes || "").trim();
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        {data.name || "Unnamed contact"}
      </div>
      {data.email   && <IconLine emoji="📧" text={data.email} />}
      {data.phone   && <IconLine emoji="📱" text={data.phone} />}
      {data.company && <IconLine emoji="🏢" text={data.company} />}
      {notes && (
        <div
          style={{
            fontStyle: "italic",
            color: "var(--fg-muted)",
            marginTop: 4,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}
        >
          {notes}
        </div>
      )}
      {!data.email && !data.phone && !data.company && !notes && (
        <div style={{ fontSize: 12, color: "var(--fg-faint)", fontStyle: "italic" }}>
          Name only — Adam can add details after the contact is created.
        </div>
      )}
    </div>
  );
}

// --- GHL contact card body ----------------------------------------------
function GhlContactBody({ data }) {
  const fullName = data.name
    || [data.firstName, data.lastName].filter(Boolean).join(" ").trim();
  const tags = Array.isArray(data.tags) ? data.tags : [];
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        {fullName || "Unnamed contact"}
      </div>
      {data.email       && <IconLine emoji="📧" text={data.email} />}
      {data.phone       && <IconLine emoji="📱" text={data.phone} />}
      {data.companyName && <IconLine emoji="🏢" text={data.companyName} />}
      {data.website     && <IconLine emoji="🌐" text={data.website} />}
      {data.source      && <IconLine emoji="📍" text={`Source: ${data.source}`} />}
      {tags.length > 0 && (
        <div className="flex flex-wrap" style={{ gap: 6, marginTop: 2 }}>
          {tags.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--fg-muted)",
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
      {!fullName && !data.email && !data.phone && (
        <div style={{ fontSize: 12, color: "var(--fg-faint)", fontStyle: "italic" }}>
          Empty draft — Adam should edit before pushing.
        </div>
      )}
    </div>
  );
}

// --- GHL update-contact card body ---------------------------------------
const GHL_UPDATE_LABELS = {
  firstName: "First name",
  lastName: "Last name",
  name: "Name",
  email: "Email",
  phone: "Phone",
  companyName: "Company",
  address1: "Address",
  city: "City",
  state: "State",
  country: "Country",
  postalCode: "Postal code",
  website: "Website",
  source: "Source",
  tags: "Tags",
};

function GhlUpdateContactBody({ data }) {
  const updates = data && typeof data.updates === "object" ? data.updates : {};
  const entries = Object.entries(updates);
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        Update GHL contact
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          id:{data.contact_id || "?"}
        </span>
      </div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--fg-faint)", fontStyle: "italic" }}>
          (no fields to change)
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 4 }}>
          {entries.map(([key, value]) => (
            <div key={key} className="flex gap-3" style={{ alignItems: "baseline" }}>
              <div
                style={{
                  width: 96,
                  fontSize: 11,
                  color: "var(--fg-faint)",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {GHL_UPDATE_LABELS[key] || key}
              </div>
              <div style={{ flex: 1, color: "var(--fg)", wordBreak: "break-word" }}>
                {Array.isArray(value) ? value.join(", ") : String(value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- GHL send-message card body ------------------------------------------
function GhlSendMessageBody({ data }) {
  const isEmail = data.message_type === "Email";
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div className="flex items-center gap-2">
        <span
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            color: "var(--fg-muted)",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {isEmail ? "Email" : "SMS"}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--fg-muted)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          to id:{data.contact_id || "?"}
        </span>
      </div>
      {isEmail && data.subject && <Row label="Subject" value={data.subject} />}
      <div>
        <div
          style={{
            fontSize: 11,
            color: "var(--fg-faint)",
            marginBottom: 4,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          Message
        </div>
        <div
          style={{
            whiteSpace: "pre-wrap",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            lineHeight: 1.55,
            color: "var(--fg)",
          }}
        >
          {data.body}
        </div>
      </div>
    </div>
  );
}

// --- GHL add-note card body ----------------------------------------------
function GhlAddNoteBody({ data }) {
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div className="flex items-center gap-2">
        <span style={{ fontSize: 16, fontWeight: 600 }}>Note</span>
        <span
          style={{
            fontSize: 12,
            color: "var(--fg-muted)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          for id:{data.contact_id || "?"}
        </span>
      </div>
      <div
        style={{
          whiteSpace: "pre-wrap",
          background: "rgba(252, 211, 77, 0.10)",
          border: "1px solid rgba(252, 211, 77, 0.45)",
          borderRadius: 6,
          padding: "10px 12px",
          lineHeight: 1.55,
          color: "var(--fg)",
        }}
      >
        {data.body}
      </div>
    </div>
  );
}

// --- Google Workspace v2 body components --------------------------------

function GoogleCalendarEventBody({ data }) {
  const attendees = Array.isArray(data.attendees) ? data.attendees : [];
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13, color: "var(--fg)" }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>
        {data.summary || "Untitled event"}
      </div>
      <IconLine emoji="🕐" text={`${data.start || "?"} → ${data.end || "?"}`} />
      {data.timezone && data.timezone !== "Europe/London" && (
        <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>{data.timezone}</div>
      )}
      {data.location    && <IconLine emoji="📍" text={data.location} />}
      {attendees.length > 0 && (
        <IconLine emoji="👥" text={attendees.join(", ")} />
      )}
      {data.description && (
        <div style={{ fontStyle: "italic", color: "var(--fg-muted)", marginTop: 4, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
          {data.description}
        </div>
      )}
    </div>
  );
}

function GoogleGmailSendBody({ data }) {
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <Row label="To"      value={data.to} />
      {data.cc  && <Row label="Cc"  value={data.cc} />}
      {data.bcc && <Row label="Bcc" value={data.bcc} />}
      <Row label="Subject" value={data.subject} />
      <div>
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Body
        </div>
        <div style={{ whiteSpace: "pre-wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", lineHeight: 1.55 }}>
          {data.body}
        </div>
      </div>
    </div>
  );
}

function GoogleDriveCreateBody({ data }) {
  const preview = (data.content || "").trim();
  const truncated = preview.length > 240;
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{data.name || "(no name)"}</div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        Will be created as a Google Doc on your Drive.
      </div>
      {preview && (
        <div style={{ whiteSpace: "pre-wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-muted)" }}>
          {truncated ? preview.slice(0, 240) + "…" : preview}
        </div>
      )}
    </div>
  );
}

function GoogleSheetsAppendBody({ data }) {
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const previewRows = rows.slice(0, 5);
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <Row label="Sheet" value={data.spreadsheet_id} />
      <Row label="Range" value={data.range || "Sheet1!A:Z"} />
      <div>
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Rows ({rows.length})
        </div>
        <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--fg-muted)" }}>
          {previewRows.map((r, i) => (
            <div key={i} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {(r || []).join("\t")}
            </div>
          ))}
          {rows.length > previewRows.length && (
            <div style={{ color: "var(--fg-faint)" }}>…and {rows.length - previewRows.length} more rows</div>
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleSheetsCreateBody({ data }) {
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{data.title || "(no title)"}</div>
      <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
        A new spreadsheet will be created on your Drive.
      </div>
    </div>
  );
}

function GoogleDocsCreateBody({ data }) {
  const preview = (data.content || "").trim();
  const truncated = preview.length > 240;
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{data.title || "(no title)"}</div>
      {preview ? (
        <div style={{ whiteSpace: "pre-wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-muted)" }}>
          {truncated ? preview.slice(0, 240) + "…" : preview}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--fg-faint)", fontStyle: "italic" }}>
          (empty doc — Adam can fill it in after creation)
        </div>
      )}
    </div>
  );
}

function GoogleDocsUpdateBody({ data }) {
  const preview = (data.content || "").trim();
  const truncated = preview.length > 320;
  return (
    <div className="flex flex-col gap-2" style={{ fontSize: 13 }}>
      <Row label="Doc" value={data.doc_id} />
      <div>
        <div style={{ fontSize: 11, color: "var(--fg-faint)", marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          New body (replaces existing content)
        </div>
        <div style={{ whiteSpace: "pre-wrap", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", color: "var(--fg-muted)" }}>
          {truncated ? preview.slice(0, 320) + "…" : preview}
        </div>
      </div>
    </div>
  );
}

// --- Action registry — small so adding new types later is a 1-line change --
const ACTION_META = {
  "gmail.send": {
    icon: Icon.Mail,
    label: "Email draft",
    confirmLabel: "Send it",
    busyLabel: "Sending…",
    editPlaceholder: "Tell Jackson what to change (tone, recipient, content)…",
    successPrefix: "Email sent to",
    successKey: (data) => data?.to,
    renderBody: (data) => <GmailBody data={data} />,
  },
  "calendar.create_event": {
    icon: Icon.Calendar,
    label: "Calendar event",
    confirmLabel: "Create event",
    busyLabel: "Creating…",
    editPlaceholder: "Tell Jackson what to change (time, attendees, details)…",
    renderBody: (data) => <CalendarBody data={data} />,
    renderSuccess: (data, result) => {
      const link = result && result.html_link;
      return (
        <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
          <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Event created
          {link ? (
            <>
              {" — "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", textDecoration: "underline" }}
              >
                opens in Google Calendar
              </a>
            </>
          ) : (
            "."
          )}
        </div>
      );
    },
  },
  "drive.create_doc": {
    icon: Icon.FileText,
    label: "Document draft",
    confirmLabel: "Create document",
    busyLabel: "Creating…",
    editPlaceholder: "Tell Jackson what to change (title, content, structure)…",
    renderBody: (data) => <DriveBody data={data} />,
    renderSuccess: (data, result) => {
      const link = result && result.web_link;
      const isDoc = (result && result.mime_type) === "application/vnd.google-apps.document"
        || (data && (data.mime_type || "application/vnd.google-apps.document") === "application/vnd.google-apps.document");
      const label = isDoc ? "opens in Google Docs" : "opens in Google Drive";
      return (
        <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
          <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Document created
          {link ? (
            <>
              {" — "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", textDecoration: "underline" }}
              >
                {label}
              </a>
            </>
          ) : (
            "."
          )}
        </div>
      );
    },
  },
  "contacts.create": {
    icon: Icon.Users,
    label: "New contact",
    confirmLabel: "Add contact",
    busyLabel: "Adding…",
    editPlaceholder: "Tell Jackson what to change (name, email, phone, company)…",
    renderBody: (data) => <ContactsBody data={data} />,
    renderSuccess: (data) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        {data?.name ? `${data.name} added to your Google Contacts.` : "Contact added to your Google Contacts."}
      </div>
    ),
  },
  "ghl.create_contact": {
    icon: Icon.TrendingUp,
    label: "New GHL contact",
    confirmLabel: "Push to GHL",
    busyLabel: "Pushing…",
    editPlaceholder: "Tell Jackson what to change (name, email, phone, company, tags)…",
    renderBody: (data) => <GhlContactBody data={data} />,
    renderSuccess: (data, result) => {
      const link = result && result.view_link;
      const displayName = data?.name
        || [data?.firstName, data?.lastName].filter(Boolean).join(" ").trim()
        || data?.email
        || "Contact";
      return (
        <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
          <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {displayName} pushed to GoHighLevel
          {link ? (
            <>
              {" — "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", textDecoration: "underline" }}
              >
                opens in GHL
              </a>
            </>
          ) : (
            "."
          )}
        </div>
      );
    },
  },
  "ghl.update_contact": {
    icon: Icon.RefreshCw,
    label: "Update GHL contact",
    confirmLabel: "Apply update",
    busyLabel: "Updating…",
    editPlaceholder: "Tell Jackson what to change (which field, which contact)…",
    renderBody: (data) => <GhlUpdateContactBody data={data} />,
    renderSuccess: (data, result) => {
      const link = result && result.view_link;
      const fieldCount = data?.updates ? Object.keys(data.updates).length : 0;
      return (
        <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
          <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          GHL contact updated{fieldCount ? ` (${fieldCount} field${fieldCount === 1 ? "" : "s"})` : ""}
          {link ? (
            <>
              {" — "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", textDecoration: "underline" }}
              >
                opens in GHL
              </a>
            </>
          ) : (
            "."
          )}
        </div>
      );
    },
  },
  "ghl.send_message": {
    icon: Icon.MessageSquare,
    label: "Send via GHL",
    confirmLabel: "Send",
    busyLabel: "Sending…",
    editPlaceholder: "Tell Jackson what to change (recipient, tone, content)…",
    renderBody: (data) => <GhlSendMessageBody data={data} />,
    renderSuccess: (data, result) => {
      const link = result && result.view_link;
      const kind = (result && result.message_type) || data?.message_type || "Message";
      return (
        <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
          <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {kind} sent via GoHighLevel
          {link ? (
            <>
              {" — "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", textDecoration: "underline" }}
              >
                opens conversation
              </a>
            </>
          ) : (
            "."
          )}
        </div>
      );
    },
  },
  "ghl.add_note": {
    icon: Icon.NotebookPen,
    label: "Add GHL note",
    confirmLabel: "Add note",
    busyLabel: "Adding…",
    editPlaceholder: "Tell Jackson what to change (which contact, the wording)…",
    renderBody: (data) => <GhlAddNoteBody data={data} />,
    renderSuccess: (data, result) => {
      const link = result && result.view_link;
      return (
        <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
          <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Note attached
          {link ? (
            <>
              {" — "}
              <a
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--green)", textDecoration: "underline" }}
              >
                opens contact in GHL
              </a>
            </>
          ) : (
            "."
          )}
        </div>
      );
    },
  },
  "google.calendar_create_event": {
    icon: Icon.Calendar,
    label: "Calendar event",
    confirmLabel: "Create event",
    busyLabel: "Creating…",
    editPlaceholder: "Tell Jackson what to change (time, attendees, details)…",
    renderBody: (data) => <GoogleCalendarEventBody data={data} />,
    renderSuccess: (_data, result) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Event created{result?.html_link ? <> — <a href={result.html_link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", textDecoration: "underline" }}>opens in Google Calendar</a></> : "."}
      </div>
    ),
  },
  "google.gmail_send": {
    icon: Icon.Mail,
    label: "Send email",
    confirmLabel: "Send",
    busyLabel: "Sending…",
    editPlaceholder: "Tell Jackson what to change (recipient, tone, content)…",
    renderBody: (data) => <GoogleGmailSendBody data={data} />,
    successPrefix: "Email sent to",
    successKey: (data) => data?.to,
  },
  "google.drive_create_file": {
    icon: Icon.FileText,
    label: "Create on Drive",
    confirmLabel: "Create file",
    busyLabel: "Creating…",
    editPlaceholder: "Tell Jackson what to change (name or content)…",
    renderBody: (data) => <GoogleDriveCreateBody data={data} />,
    renderSuccess: (data, result) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Created {result?.title || data?.name}{result?.url ? <> — <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", textDecoration: "underline" }}>opens in Drive</a></> : "."}
        {result?.warning && (
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{result.warning}</div>
        )}
      </div>
    ),
  },
  "google.sheets_append": {
    icon: Icon.Database,
    label: "Append to spreadsheet",
    confirmLabel: "Append rows",
    busyLabel: "Appending…",
    editPlaceholder: "Tell Jackson what to change (which sheet, which rows)…",
    renderBody: (data) => <GoogleSheetsAppendBody data={data} />,
    renderSuccess: (_data, result) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Appended {result?.updated_rows || "rows"} to {result?.updated_range || "the sheet"}
        {result?.url ? <> — <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", textDecoration: "underline" }}>opens in Sheets</a></> : "."}
      </div>
    ),
  },
  "google.sheets_create": {
    icon: Icon.Database,
    label: "Create spreadsheet",
    confirmLabel: "Create",
    busyLabel: "Creating…",
    editPlaceholder: "Tell Jackson what to change (the title)…",
    renderBody: (data) => <GoogleSheetsCreateBody data={data} />,
    renderSuccess: (_data, result) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Created {result?.title}{result?.url ? <> — <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", textDecoration: "underline" }}>opens in Sheets</a></> : "."}
      </div>
    ),
  },
  "google.docs_create": {
    icon: Icon.FileText,
    label: "Create Google Doc",
    confirmLabel: "Create",
    busyLabel: "Creating…",
    editPlaceholder: "Tell Jackson what to change (title or content)…",
    renderBody: (data) => <GoogleDocsCreateBody data={data} />,
    renderSuccess: (data, result) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Created {result?.title || data?.title}{result?.url ? <> — <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", textDecoration: "underline" }}>opens in Docs</a></> : "."}
        {result?.warning && (
          <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{result.warning}</div>
        )}
      </div>
    ),
  },
  "google.docs_update": {
    icon: Icon.FileText,
    label: "Update Google Doc",
    confirmLabel: "Replace body",
    busyLabel: "Updating…",
    editPlaceholder: "Tell Jackson what to change (the new body)…",
    renderBody: (data) => <GoogleDocsUpdateBody data={data} />,
    renderSuccess: (_data, result) => (
      <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
        <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        Doc updated{result?.url ? <> — <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--green)", textDecoration: "underline" }}>opens in Docs</a></> : "."}
      </div>
    ),
  },
};

// Map an action_type to the integration tool_id whose credentials it needs,
// plus a human-readable context for the SetupModal subtitle. Used by the
// pre-confirm banner so Adam sees a "set up first" affordance instead of
// only finding out at click-time.
const ACTION_TOOL_REQUIREMENTS = {
  "ghl.create_contact": { tool: "ghl", context: "to push contacts into GHL" },
  "ghl.update_contact": { tool: "ghl", context: "to update GHL contacts" },
  "ghl.send_message":   { tool: "ghl", context: "to send messages via GHL" },
  "ghl.add_note":       { tool: "ghl", context: "to attach notes in GHL" },
  "google.calendar_create_event": { tool: "google", context: "to create a calendar event" },
  "google.gmail_send":             { tool: "google", context: "to send an email" },
  "google.drive_create_file":      { tool: "google", context: "to create a Drive file" },
  "google.sheets_append":          { tool: "google", context: "to append rows to a spreadsheet" },
  "google.sheets_create":          { tool: "google", context: "to create a spreadsheet" },
  "google.docs_create":            { tool: "google", context: "to create a Google Doc" },
  "google.docs_update":            { tool: "google", context: "to update a Google Doc" },
};

// --- Main card ------------------------------------------------------------
function ActionCard({ token, onEditRequest, onNeedsSetup }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState(null); // { kind: 'sent' | 'cancelled' | 'error' | 'already', ...}
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  const editRef = useRef(null);
  // null = unknown (still checking), true = configured, false = needs setup.
  // Only populated for action types in ACTION_TOOL_REQUIREMENTS.
  const [toolConfigured, setToolConfigured] = useState(null);

  // Load pending row once per token.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setPending(null);
    setTerminal(null);
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/tools/pending/${encodeURIComponent(token)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setPending(data);
        // If the backend already marked this as executed/cancelled/expired,
        // move straight into the terminal state so the card can't be re-fired.
        if (data.status === "executed") {
          setTerminal({ kind: "already", at: data.executed_at });
        } else if (data.status === "cancelled") {
          setTerminal({ kind: "cancelled" });
        } else if (data.status === "expired") {
          setTerminal({ kind: "expired" });
        }
      } catch (err) {
        if (!cancelled) setLoadError(err?.message || "Could not load action.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (editOpen && editRef.current) editRef.current.focus();
  }, [editOpen]);

  // Pre-flight check: if this action depends on an integration that might be
  // unconfigured (e.g. GHL), poll its status so the card can render a banner
  // before Adam clicks Confirm. Only runs for action types we know about.
  const pendingActionType = pending?.action_type;
  const requirement = pendingActionType ? ACTION_TOOL_REQUIREMENTS[pendingActionType] : null;
  useEffect(() => {
    if (!requirement) {
      setToolConfigured(null);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/integrations/${requirement.tool}/status`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) setToolConfigured(!!data.connected);
      } catch {
        if (!cancelled) setToolConfigured(null);  // unknown — don't block
      }
    })();
    return () => { cancelled = true; };
  }, [requirement?.tool, terminal?.kind]);

  const confirm = async () => {
    if (busy || terminal) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/tools/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation_token: token }),
      });
      const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
      if (!res.ok && res.status === 409) {
        setTerminal({ kind: "already" });
      } else if (data?.success) {
        setTerminal({ kind: "sent", at: new Date().toISOString(), result: data.result });
      } else {
        // Backend returned a `needs_setup` signal → surface to the parent so
        // the SetupModal pops, instead of leaving a cryptic error on the card.
        // Backend `needs_api_enable` rides on the terminal state itself so the
        // card renders an inline activation link (NOT the modal).
        if (data?.needs_setup && onNeedsSetup) {
          onNeedsSetup(data.needs_setup);
        }
        setTerminal({
          kind: "error",
          error: data?.error || `HTTP ${res.status}`,
          needs_api_enable: data?.needs_api_enable || null,
        });
      }
    } catch (err) {
      setTerminal({ kind: "error", error: err?.message || "Network error." });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy || terminal) return;
    setBusy(true);
    try {
      await fetch(`${API_BASE}/tools/cancel/${encodeURIComponent(token)}`, { method: "POST" });
      setTerminal({ kind: "cancelled" });
    } catch {
      setTerminal({ kind: "error", error: "Could not cancel." });
    } finally {
      setBusy(false);
    }
  };

  const retry = () => {
    // Only valid on error — backend left the row as 'pending', so another
    // /tools/execute hits the same token. Clear terminal to re-arm the card.
    setTerminal(null);
  };

  const submitEdit = () => {
    const v = editText.trim();
    if (!v) return;
    onEditRequest?.(`Revise that draft: ${v}`);
    // Cancel this draft so Adam doesn't also have a stale card around.
    cancel();
    setEditText("");
    setEditOpen(false);
  };

  // --- Render cases -------------------------------------------------------

  if (loading) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 13, color: "var(--fg-faint)" }}>Loading action…</div>
      </div>
    );
  }
  if (loadError || !pending) {
    return (
      <div style={{ ...cardStyle, borderColor: "var(--border-strong)" }}>
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          {loadError || "Action not found. It may have expired."}
        </div>
      </div>
    );
  }

  const meta = ACTION_META[pending.action_type];
  if (!meta) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: 13, color: "var(--fg-muted)" }}>
          Unknown action type: {pending.action_type}
        </div>
      </div>
    );
  }
  const IconCmp = meta.icon;
  const data = pending.action_data || {};

  // --- Terminal states -------------------------------------------------
  if (terminal) {
    const { kind } = terminal;
    if (kind === "sent") {
      return (
        <div style={{ ...cardStyle, borderColor: "var(--border)" }}>
          <HeaderRow IconCmp={IconCmp} label={meta.label} muted />
          {meta.renderSuccess ? (
            meta.renderSuccess(data, terminal.result)
          ) : (
            <div style={{ fontSize: 13, color: "var(--green)", marginTop: 8 }}>
              <Icon.Check className="lucide-xs" style={{ verticalAlign: "-2px", marginRight: 6 }} />
              {meta.successPrefix} {meta.successKey?.(data) || ""}
              {terminal.at ? ` at ${friendlyTime(terminal.at)}` : ""}.
            </div>
          )}
        </div>
      );
    }
    if (kind === "already") {
      return (
        <div style={{ ...cardStyle, opacity: 0.75 }}>
          <HeaderRow IconCmp={IconCmp} label={meta.label} muted />
          <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8 }}>
            Already executed.
          </div>
        </div>
      );
    }
    if (kind === "cancelled") {
      return (
        <div style={{ ...cardStyle, opacity: 0.6 }}>
          <HeaderRow IconCmp={IconCmp} label={meta.label} muted cancelled />
          {meta.renderBody(data)}
          <div style={{ fontSize: 12, color: "var(--fg-faint)", marginTop: 10 }}>Cancelled.</div>
        </div>
      );
    }
    if (kind === "expired") {
      return (
        <div style={{ ...cardStyle, opacity: 0.6 }}>
          <HeaderRow IconCmp={IconCmp} label={meta.label} muted />
          <div style={{ fontSize: 13, color: "var(--fg-muted)", marginTop: 8 }}>
            This draft expired (over an hour old). Ask Jackson for a fresh one.
          </div>
        </div>
      );
    }
    if (kind === "error") {
      return (
        <div style={cardStyle}>
          <HeaderRow IconCmp={IconCmp} label={meta.label} />
          {meta.renderBody(data)}
          {terminal.needs_api_enable && <ApiEnableBanner info={terminal.needs_api_enable} />}
          <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 10 }}>
            {terminal.error || "Something went wrong."}
          </div>
          <div className="flex gap-2 flex-wrap" style={{ marginTop: 10 }}>
            <button onClick={retry} className="btn-primary px-3 py-1.5" style={{ fontSize: 13 }}>
              Retry
            </button>
            <button onClick={cancel} className="btn-secondary px-3 py-1.5" style={{ fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      );
    }
  }

  // --- Active (pre-confirmation) ---------------------------------------
  return (
    <div style={cardStyle}>
      <HeaderRow IconCmp={IconCmp} label={meta.label} />
      {meta.renderBody(data)}

      {editOpen && (
        <div style={{ marginTop: 10 }}>
          <textarea
            ref={editRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            rows={2}
            placeholder={meta.editPlaceholder || "Tell Jackson what to change…"}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: 13,
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              background: "var(--bg)",
              color: "var(--fg)",
              resize: "vertical",
            }}
          />
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            <button
              type="button"
              onClick={submitEdit}
              className="btn-primary px-3 py-1"
              disabled={!editText.trim()}
              style={{ fontSize: 12 }}
            >
              Send revision request
            </button>
            <button
              type="button"
              onClick={() => { setEditOpen(false); setEditText(""); }}
              className="btn-secondary px-3 py-1"
              style={{ fontSize: 12 }}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {requirement && toolConfigured === false && (
        <div
          style={{
            marginTop: 12,
            padding: "8px 10px",
            background: "rgba(180,67,44,0.06)",
            border: "1px solid rgba(180,67,44,0.35)",
            borderRadius: 6,
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            fontSize: 12,
            color: "var(--fg)",
            lineHeight: 1.5,
          }}
        >
          <Icon.AlertTriangle className="lucide-xs" style={{ color: "var(--danger)", marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ color: "var(--fg)" }}>
              {requirement.tool.toUpperCase()} not configured — clicking confirm will fail.
            </div>
            <button
              type="button"
              onClick={() => onNeedsSetup?.({ tools: [requirement.tool], context: requirement.context })}
              className="btn-ghost"
              style={{
                marginTop: 4,
                padding: 0,
                fontSize: 12,
                color: "var(--accent)",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              Set up {requirement.tool.toUpperCase()} first →
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap" style={{ marginTop: 12 }}>
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="btn-primary px-3 py-1.5"
          style={{ fontSize: 13 }}
        >
          {busy ? (meta.busyLabel || "Working…") : meta.confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setEditOpen((o) => !o)}
          disabled={busy}
          className="btn-secondary px-3 py-1.5"
          style={{ fontSize: 13 }}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={busy}
          className="btn-ghost px-3 py-1.5"
          style={{ fontSize: 13, color: "var(--fg-muted)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Inline banner inside an action card when /tools/execute fails because the
// underlying Google API isn't enabled in Cloud Console. Same shape as the
// Chat-level banner, scoped to the failed card so Adam sees it next to the
// retry button. Distinct from the SetupModal flow.
function ApiEnableBanner({ info }) {
  if (!info || !info.console_url) return null;
  const label = info.service_label || "Google API";
  const open = () => {
    try { window.open(info.console_url, "mc-google-enable", "noopener,noreferrer"); } catch { /* ignore */ }
  };
  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        background: "rgba(180, 67, 44, 0.06)",
        border: "1px solid rgba(180, 67, 44, 0.35)",
        borderRadius: 8,
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <Icon.AlertTriangle className="lucide-sm" style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "var(--fg)", fontWeight: 500, marginBottom: 4 }}>
          {label} isn't enabled in your Google Cloud project
        </div>
        <div style={{ color: "var(--fg-muted)", marginBottom: 8 }}>
          Click below, enable it in the Console, wait ~30 seconds for propagation, then Retry.
        </div>
        <button
          type="button"
          onClick={open}
          className="btn-secondary"
          style={{
            fontSize: 12,
            padding: "4px 10px",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Icon.ExternalLink className="lucide-xs" />
          Open Cloud Console to enable
        </button>
      </div>
    </div>
  );
}

function HeaderRow({ IconCmp, label, muted, cancelled }) {
  return (
    <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
      {IconCmp && (
        <IconCmp
          className="lucide-sm"
          style={{ color: cancelled ? "var(--fg-faint)" : muted ? "var(--fg-muted)" : "var(--accent)" }}
        />
      )}
      <div style={{ fontSize: 13, fontWeight: 500, color: muted ? "var(--fg-muted)" : "var(--fg)" }}>
        {label}
      </div>
    </div>
  );
}

const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 14,
  background: "var(--bg-elev)",
  margin: "8px 0",
};

// --- Splitter used by Chat to interleave markdown and cards ---------------
// Returns an array of { kind: 'text' | 'card', ... } pieces. Chat renders
// text parts with renderMarkdown and card parts with <ActionCard />.
export function splitByActionCards(text) {
  if (!text) return [];
  const re = new RegExp(ACTION_CARD_MARKER_RE.source, "g");
  const pieces = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) pieces.push({ kind: "text", text: text.slice(last, m.index) });
    pieces.push({ kind: "card", token: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}

export default ActionCard;
