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
