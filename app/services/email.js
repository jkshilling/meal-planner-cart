// Outbound email via Resend. Only used by the password-reset flow right
// now, but designed to be reusable for any one-shot transactional email
// the app needs later (invite delivery, weekly-plan-ready notifications).
//
// Configuration (env):
//   RESEND_API_KEY  — sole credential; without it, isEnabled() returns
//                     false and sendEmail() resolves to { ok: false }
//                     without throwing. Callers should treat that as
//                     "email backend unconfigured; tell the user to
//                     reach out another way" rather than crashing.
//   EMAIL_FROM      — sender, format "Name <addr@verified.domain>". The
//                     domain must be verified in your Resend account or
//                     Resend rejects the send. Defaults to a placeholder
//                     that will fail loudly — explicit config is required.
//   APP_URL         — fully-qualified URL of the app (e.g.
//                     https://meals.alaskatargeting.com). Used when
//                     building the absolute URLs in email bodies. Without
//                     it we fall back to relative URLs which won't work
//                     in an email client.
//
// Failure semantics: every send is best-effort. We log warnings on
// failure but never throw. The caller decides whether a missing email
// is a hard error or a soft skip.

const RESEND_URL = 'https://api.resend.com/emails';

function apiKey() {
  return process.env.RESEND_API_KEY || '';
}

function isEnabled() {
  return !!apiKey();
}

function fromAddr() {
  return process.env.EMAIL_FROM || 'Meal Planner <onboarding@resend.dev>';
}

function appUrl() {
  return (process.env.APP_URL || '').replace(/\/$/, '');
}

// Send a single transactional email. Returns { ok: boolean, id?: string,
// reason?: string }. Never throws. `to` can be a string or an array of
// addresses.
async function sendEmail({ to, subject, text, html }) {
  if (!isEnabled()) {
    console.warn('[email] RESEND_API_KEY not set; skipping send to', to);
    return { ok: false, reason: 'RESEND_API_KEY not set' };
  }
  if (!to || !subject || !(text || html)) {
    return { ok: false, reason: 'missing to/subject/body' };
  }

  const body = {
    from: fromAddr(),
    to: Array.isArray(to) ? to : [to],
    subject
  };
  if (text) body.text = text;
  if (html) body.html = html;

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey()}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[email] Resend HTTP', res.status, detail.slice(0, 200));
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data.id || null };
  } catch (e) {
    console.warn('[email] Resend network error:', e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { isEnabled, sendEmail, appUrl };
