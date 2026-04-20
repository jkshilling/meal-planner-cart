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

app.use(require('./routes/index'));
app.use(require('./routes/settings'));
app.use(require('./routes/recipes'));
app.use(require('./routes/planner'));
app.use(require('./routes/plan'));

app.use((req, res) => res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Server error', message: err.message });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
app.listen(PORT, () => {
  console.log(`Meal Planner running at http://localhost:${PORT}`);
});
