require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const db = require('./db');
const { stringify } = require('csv-stringify');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false // keep simple for demo; turn on & tune CSP in production
}));

// Static & parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Sessions
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));

// Optional mail transport
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// Middleware to expose session to views
app.use((req, res, next) => {
  res.locals.isAuthed = !!req.session.isAuthed;
  next();
});

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.post('/lead', async (req, res) => {
  try {
    const { name, email, phone, insurance_type, message } = req.body;
    if (!name || !email || !phone || !insurance_type) {
      return res.status(400).send('Missing required fields');
    }
    const source = req.get('referer') || 'direct';
    const created_at = new Date().toISOString();

    db.run(
      `INSERT INTO leads (name, email, phone, insurance_type, message, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, email, phone, insurance_type, message || '', source, created_at],
      function (err) {
        if (err) {
          console.error(err);
          return res.status(500).send('Database error');
        }

        // Send email notification if configured
        if (transporter && process.env.NOTIFY_TO && process.env.NOTIFY_FROM) {
          transporter.sendMail({
            from: process.env.NOTIFY_FROM,
            to: process.env.NOTIFY_TO,
            subject: `New Lead: ${name} (${insurance_type})`,
            text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nType: ${insurance_type}\nMessage: ${message || ''}\nSource: ${source}\nTime: ${created_at}`
          }).catch(console.error);
        }

        res.redirect('/thank-you');
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/thank-you', (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
        <link href="/styles.css" rel="stylesheet">
        <title>Thank You</title>
      </head>
      <body class="bg-light d-flex align-items-center" style="min-height:100vh;">
        <div class="container text-center">
          <div class="card shadow mx-auto" style="max-width: 560px;">
            <div class="card-body p-5">
              <h1 class="h3 mb-3">Thanks! 🎉</h1>
              <p class="text-muted">Your info has been received. An agent will reach out shortly.</p>
              <a class="btn btn-primary" href="/">Back to home</a>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
});

// Admin auth
function ensureAuthed(req, res, next) {
  if (req.session.isAuthed) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  if (req.session.isAuthed) return res.redirect('/admin/leads');
  res.render('admin', { view: 'login', leads: [], q: '' });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.redirect('/admin');
  if (password === (process.env.ADMIN_PASSWORD || 'change-me')) {
    req.session.isAuthed = true;
    return res.redirect('/admin/leads');
  }
  res.render('admin', { view: 'login', error: 'Invalid password', leads: [], q: '' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

app.get('/admin/leads', ensureAuthed, (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const sql = q
    ? `SELECT * FROM leads WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR insurance_type LIKE ? ORDER BY datetime(created_at) DESC`
    : `SELECT * FROM leads ORDER BY datetime(created_at) DESC`;
  const params = q ? [like, like, like, like] : [];

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database error');
    }
    res.render('admin', { view: 'leads', leads: rows, q });
  });
});

app.get('/admin/export.csv', ensureAuthed, (req, res) => {
  db.all('SELECT * FROM leads ORDER BY datetime(created_at) DESC', [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database error');
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    const stringifier = stringify({ header: true });
    stringifier.on('readable', () => {
      let row;
      while ((row = stringifier.read())) {
        res.write(row);
      }
    });
    stringifier.on('error', (err) => console.error(err.message));
    stringifier.on('finish', () => res.end());
    rows.forEach(r => stringifier.write(r));
    stringifier.end();
  });
});

// Sample data seed (only if table empty)
function seedIfEmpty() {
  db.get('SELECT COUNT(*) as count FROM leads', (err, row) => {
    if (err) return console.error(err);
    if (row.count === 0) {
      const stmt = db.prepare('INSERT INTO leads (name, email, phone, insurance_type, message, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const samples = [
        ['Alex Johnson', 'alex@example.com', '555-111-2222', 'Auto', 'Looking for full coverage', 'sample', new Date().toISOString()],
        ['Maria Lopez', 'maria@example.com', '555-333-4444', 'Home', 'Bundle with auto?', 'sample', new Date().toISOString()],
        ['Sam Patel', 'sam@example.com', '555-555-6666', 'Life', 'Term vs whole life', 'sample', new Date().toISOString()],
        ['Chris Kim', 'chris@example.com', '555-777-8888', 'Health', 'Family plan', 'sample', new Date().toISOString()],
        ['Taylor Smith', 'taylor@example.com', '555-999-0000', 'Business', 'General liability quote', 'sample', new Date().toISOString()],
      ];
      samples.forEach(s => stmt.run(s));
      stmt.finalize();
      console.log('Seeded 5 sample leads.');
    }
  });
}

seedIfEmpty();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
