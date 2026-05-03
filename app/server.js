require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);

// Loads db.js which initializes the schema on require.
const db = require('./db');

const app = express();

// Trust the nginx proxy in front of us so secure-cookie + ip detection work.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions: SQLite-backed so they survive systemd restarts. Same DB file as
// everything else — the store creates its own `sessions` table on first run.
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 }  // sweep expired every 15m
  }),
  name: 'mp.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-replace-in-env',
  resave: false,
  saveUninitialized: false,
  rolling: true,  // refresh expiry on every request so active sessions don't expire mid-use
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 days
    secure: process.env.NODE_ENV === 'production'
  }
}));

// Flash messages: anything written to req.session.flash gets surfaced to the
// next-rendered view as `flash`, then cleared.
app.use((req, res, next) => {
  res.locals.flash = null;
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
});

// Expose display helpers + current user to all views. Mounted before
// csrf.verify so a CSRF-rejection error page still has the nav locals
// (currentUser) it needs to render.
const { formatDate, formatDateTime } = require('./services/format');
app.use((req, res, next) => {
  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.currentUser = (req.session && req.session.user) ? req.session.user : null;
  next();
});

// CSRF: ensure a session token exists (exposed to views via res.locals.csrfToken)
// and verify state-changing requests carry it. Bearer-authed JSON endpoints
// (extension talks to /api/grocery-events and /api/grocery/favorites) are
// exempt — see services/csrf.js.
const csrf = require('./services/csrf');
app.use(csrf.ensureToken);
app.use(csrf.verify);

app.use(require('./routes/auth'));
app.use(require('./routes/index'));
app.use(require('./routes/settings'));
app.use(require('./routes/recipes'));
app.use(require('./routes/planner'));
app.use(require('./routes/plan'));
app.use(require('./routes/grocery_events'));
app.use(require('./routes/grocery_dashboard'));

app.use((req, res) => res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Server error', message: err.message });
});

// Always bind to loopback. On a shared host, nginx is the only front door;
// binding to 0.0.0.0 would expose the app directly and bypass TLS/auth.
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Meal Planner running at http://${HOST}:${PORT}`);
});
