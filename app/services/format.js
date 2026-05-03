// Display formatters exposed to views via res.locals.
//
// SQLite's `datetime('now')` produces "YYYY-MM-DD HH:MM:SS" in UTC. Rendering
// that string raw in HTML reads as a clunky log line. These helpers convert
// it into something humans want to see.
//
// All formatting happens in UTC so output is identical regardless of which
// host (Mac vs droplet) renders the page. The (UTC) suffix on time-of-day
// formats is intentional — Alaska / Pacific / UTC are far enough apart that
// hiding the timezone would be misleading.

function parseSqlTime(s) {
  if (!s) return null;
  // SQLite emits naive UTC; appending Z forces UTC parsing.
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

// Number of UTC days since epoch — used to compare two dates by calendar
// day without timezone drift.
function utcDayIndex(d) {
  return Math.floor(d.getTime() / 86_400_000);
}

// Smart relative date format. Examples:
//   Today / Yesterday / Sun / Wed
//   May 3 / Dec 14
//   May 3, 2025
function formatDate(s) {
  const d = parseSqlTime(s);
  if (!d) return '—';
  const now = new Date();
  const diff = utcDayIndex(now) - utcDayIndex(d);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  if (d.getUTCFullYear() === now.getUTCFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Date + time. Examples:
//   Today at 12:11 PM UTC
//   Yesterday at 4:30 PM UTC
//   May 3 at 9:00 AM UTC
function formatDateTime(s) {
  const d = parseSqlTime(s);
  if (!d) return '—';
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return `${formatDate(s)} at ${time} UTC`;
}

module.exports = { formatDate, formatDateTime };
