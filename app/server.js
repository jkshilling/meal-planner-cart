require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const path = require('path');

// Loads db.js which initializes the schema on require.
require('./db');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Expose feature flags to all views so templates can conditionally render.
app.use((req, res, next) => {
  res.locals.walmartEnabled = process.env.WALMART_ENABLED === 'true';
  next();
});

app.use(require('./routes/index'));
app.use(require('./routes/settings'));
app.use(require('./routes/recipes'));
app.use(require('./routes/planner'));
app.use(require('./routes/plan'));
app.use(require('./routes/products'));

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
