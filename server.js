'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
app.set('trust proxy', 1); // коректний IP за проксі (Render)

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

// ---------- Налаштування (зі змінних середовища) ----------
const PORT = process.env.PORT || 3000;
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'berezne2024';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please-in-production';
const TOKEN_TTL = '12h';

const CATEGORIES = ['Екологія', 'Інфраструктура', 'Культура', 'Освіта', 'Інше'];

// ---------- Допоміжні ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Присвоюємо кожному браузеру анонімний client_id (для захисту від накрутки голосів)
function ensureClientId(req, res) {
  let cid = req.cookies && req.cookies.cid;
  if (!cid) {
    cid = crypto.randomBytes(16).toString('hex');
    res.cookie('cid', cid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2, // 2 роки
    });
  }
  return cid;
}

// Перевірка адмін-токена. Повертає true, якщо валідний.
function isAdminReq(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload && payload.role === 'admin';
  } catch (e) {
    return false;
  }
}

// Middleware, що вимагає адміна
function requireAdmin(req, res, next) {
  if (!isAdminReq(req)) return res.status(401).json({ error: 'Потрібна авторизація адміністратора' });
  next();
}

// ---------- Rate limiting ----------
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // не більше 5 нових ідей за хвилину з одного IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб. Зачекайте трохи.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // захист від перебору пароля
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб входу. Спробуйте пізніше.' },
});

// ================= API =================

// Список ідей. Контакти повертаються ЛИШЕ адміну.
app.get('/api/ideas', (req, res) => {
  const cid = ensureClientId(req, res);
  const admin = isAdminReq(req);

  const rows = db.prepare('SELECT * FROM ideas ORDER BY ts DESC').all();
  const votedRows = db.prepare('SELECT idea_id FROM votes WHERE client_id = ?').all(cid);
  const votedSet = new Set(votedRows.map((r) => r.idea_id));

  const result = rows.map((r) => {
    const item = {
      id: r.id,
      name: r.name || '',
      cat: r.cat,
      text: r.text,
      votes: r.votes,
      status: r.status,
      ts: r.ts,
      voted: votedSet.has(r.id),
    };
    // Контакт бачить тільки адмін
    if (admin) item.contact = r.contact || '';
    return item;
  });

  res.json(result);
});

// Створення нової ідеї
app.post('/api/ideas', submitLimiter, (req, res) => {
  const body = req.body || {};
  const name = (body.name || '').toString().trim().slice(0, 50);
  const cat = (body.cat || '').toString().trim();
  const text = (body.text || '').toString().trim().slice(0, 1000);
  const contact = (body.contact || '').toString().trim().slice(0, 100);

  if (!CATEGORIES.includes(cat)) return res.status(400).json({ error: 'Невірна категорія' });
  if (text.length < 20) return res.status(400).json({ error: 'Опишіть ідею детальніше (мінімум 20 символів).' });

  const cid = ensureClientId(req, res);
  const id = 'idea_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  const ts = Date.now();

  db.prepare(
    'INSERT INTO ideas (id, name, cat, text, contact, votes, status, ts) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(id, name, cat, text, contact, 'нова', ts);

  // Автор автоматично голосує за свою ідею
  db.prepare('INSERT OR IGNORE INTO votes (idea_id, client_id, ts) VALUES (?, ?, ?)').run(id, cid, ts);

  res.status(201).json({ id, name, cat, text, votes: 1, status: 'нова', ts, voted: true });
});

// Голосування (toggle)
app.post('/api/ideas/:id/vote', (req, res) => {
  const cid = ensureClientId(req, res);
  const id = req.params.id;
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(id);
  if (!idea) return res.status(404).json({ error: 'Ідею не знайдено' });

  const existing = db.prepare('SELECT 1 FROM votes WHERE idea_id = ? AND client_id = ?').get(id, cid);

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare('DELETE FROM votes WHERE idea_id = ? AND client_id = ?').run(id, cid);
      db.prepare('UPDATE ideas SET votes = MAX(0, votes - 1) WHERE id = ?').run(id);
    } else {
      db.prepare('INSERT INTO votes (idea_id, client_id, ts) VALUES (?, ?, ?)').run(id, cid, Date.now());
      db.prepare('UPDATE ideas SET votes = votes + 1 WHERE id = ?').run(id);
    }
  });
  tx();

  const updated = db.prepare('SELECT votes FROM ideas WHERE id = ?').get(id);
  res.json({ votes: updated.votes, voted: !existing });
});

// Вхід адміна
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const body = req.body || {};
  const login = (body.login || '').toString();
  const password = (body.password || '').toString();

  if (safeEqual(login, ADMIN_LOGIN) && safeEqual(password, ADMIN_PASSWORD)) {
    const token = jwt.sign({ role: 'admin', login }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Невірний логін або пароль.' });
});

// Перевірка токена
app.get('/api/admin/me', (req, res) => {
  res.json({ admin: isAdminReq(req) });
});

// Адмін: змінити статус ідеї
app.patch('/api/ideas/:id', requireAdmin, (req, res) => {
  const allowed = ['нова', 'на розгляді', 'прийнято'];
  const status = (req.body && req.body.status || '').toString();
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Невірний статус' });
  const info = db.prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Ідею не знайдено' });
  res.json({ ok: true, status });
});

// Адмін: видалити ідею
app.delete('/api/ideas/:id', requireAdmin, (req, res) => {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM votes WHERE idea_id = ?').run(req.params.id);
    db.prepare('DELETE FROM ideas WHERE id = ?').run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// ---------- Статика (фронтенд) ----------
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});
