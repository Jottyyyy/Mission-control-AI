// Date/time + size formatters for v1.23 Google read renderers.
//
// All functions tolerate undefined/null/garbage input and return a sensible
// fallback rather than throwing — they're called from JSX render paths where
// a thrown error would unmount the chat.

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseDate(input) {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const s = String(input);
  // Accept "YYYY-MM-DD" (date-only / all-day events) by anchoring at local midnight.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(dateOnly ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const MONTH_DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric", year: "numeric",
});

// "Today 3:00 PM" / "Yesterday 9:00 AM" / "Tomorrow 11:30 AM" / "Friday 2:00 PM" / "Apr 28 at 3:00 PM".
export function formatFriendlyTime(input) {
  const d = parseDate(input);
  if (!d) return input ? String(input) : "";
  const now = new Date();
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  const time = TIME_FMT.format(d);
  if (diff === 0) return `Today ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff > 1 && diff <= 6) return `${WEEKDAY_FMT.format(d)} ${time}`;
  return `${MONTH_DAY_FMT.format(d)} at ${time}`;
}

// "Today" / "Yesterday" / "Friday" / "Apr 28" — date only, for all-day events
// where a clock time would be misleading.
export function formatFriendlyDate(input) {
  const d = parseDate(input);
  if (!d) return input ? String(input) : "";
  const now = new Date();
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff <= 6) return WEEKDAY_FMT.format(d);
  return MONTH_DAY_FMT.format(d);
}

// "just now" / "5 minutes ago" / "2 hours ago" / "Yesterday" / "3 days ago" / "Apr 25".
export function formatRelativeTime(input) {
  const d = parseDate(input);
  if (!d) return input ? String(input) : "";
  const now = Date.now();
  const ms = now - d.getTime();
  if (ms < 0) {
    // Future — fall through to friendly forward-looking format.
    return formatFriendlyTime(d);
  }
  const sec = Math.round(ms / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / DAY_MS);
  if (days === 1) return "Yesterday";
  if (days >= 2 && days <= 6) return `${days} days ago`;
  return MONTH_DAY_FMT.format(d);
}

// "456 B" / "12.4 KB" / "2.4 MB" / "1.2 GB". Accepts numbers or numeric strings.
export function formatFileSize(input) {
  const n = typeof input === "number" ? input : parseInt(input, 10);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Same-day key used for grouping calendar events under "Today" / "Tomorrow" /
// "Friday" headers in the calendar card.
export function dayBucket(input) {
  const d = parseDate(input);
  if (!d) return "—";
  const now = new Date();
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff <= 6) return WEEKDAY_FMT.format(d);
  return FULL_FMT.format(d);
}

// "3:00 PM" — used on the card row, paired with the day bucket header.
export function formatTimeOnly(input) {
  const d = parseDate(input);
  if (!d) return input ? String(input) : "";
  return TIME_FMT.format(d);
}

// "5h 30m" / "45m" / "2h" — duration between two ISO timestamps, with no
// leading zero on the minute and no "0h" prefix. Returns "" if either end
// is unparseable; less than a minute clamps to "<1m" so the row still has
// some signal rather than a mysterious blank.
export function formatDuration(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return "";
  const ms = e.getTime() - s.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// Period of day used for table/list section dividers. Boundaries match the
// v1.25 spec: 05:00–11:59 morning, 12:00–16:59 afternoon, 17:00–21:59
// evening, 22:00–04:59 late night. Single source of truth — both LIST and
// TABLE views use this so they stay aligned.
export const PERIOD_DEFS = [
  { key: "morning",   label: "Morning",    range: "05:00–11:59" },
  { key: "afternoon", label: "Afternoon",  range: "12:00–16:59" },
  { key: "evening",   label: "Evening",    range: "17:00–21:59" },
  { key: "late",      label: "Late Night", range: "22:00–04:59" },
  { key: "allday",    label: "All day",    range: "" },
];

export function periodKey(ev) {
  if (!ev) return "morning";
  if (ev.all_day) return "allday";
  const d = parseDate(ev.start);
  if (!d) return "morning";
  const h = d.getHours();
  if (h >= 22 || h < 5) return "late";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

// Group events by period in canonical order, dropping empty periods. The
// caller passes already-sorted events; this just bucketises.
export function groupByPeriod(events) {
  const buckets = new Map();
  for (const ev of events || []) {
    const key = periodKey(ev);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ev);
  }
  // All-day on top, then chronological periods.
  const order = ["allday", "morning", "afternoon", "evening", "late"];
  return order
    .filter((k) => buckets.has(k))
    .map((k) => ({ ...PERIOD_DEFS.find((p) => p.key === k), events: buckets.get(k) }));
}

// "Today" / "Tomorrow" / "Yesterday" / "Mon May 4". Used by the day-header
// strip above the table/list. Returns null if the input is unparseable so
// the caller can omit the strip rather than render a broken header.
const FULL_HEADER_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});

export function dayHeaderLabel(input) {
  const d = parseDate(input);
  if (!d) return null;
  const now = new Date();
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return { primary: "Today", secondary: FULL_HEADER_FMT.format(d) };
  if (diff === 1) return { primary: "Tomorrow", secondary: FULL_HEADER_FMT.format(d) };
  if (diff === -1) return { primary: "Yesterday", secondary: FULL_HEADER_FMT.format(d) };
  return { primary: FULL_HEADER_FMT.format(d), secondary: null };
}

// Equality check for "is this date the user's local today?" — used by the
// card to decide whether to apply Now-pill / dimmed-past treatment, which
// we only want on today's view.
export function isLocalToday(input) {
  const d = parseDate(input);
  if (!d) return false;
  return startOfDay(d) === startOfDay(new Date());
}
