'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { connect } = require('./db');

const app = express();
app.set('trust proxy', 1); // коректний IP за проксі (Render)

app.use(express.json({ limit: '32kb' }));
app.use(cookieParser());

// ---------- Налаштування (зі змінних середовища) ----------
// Немає жодних fallback-значень для секретів навмисно: якщо змінна не
// задана в Render, сервер повинен впасти з чіткою помилкою при старті,
// а не тихо піднятися з дефолтним паролем, який лежить у публічному репо.
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Відсутня обов'язкова змінна середовища: ${name}. Сервер не запущено.`);
    process.exit(1);
  }
  return v;
}

const PORT = process.env.PORT || 3000;
const ADMIN_LOGIN = requireEnv('ADMIN_LOGIN');
const ADMIN_PASSWORD = requireEnv('ADMIN_PASSWORD');
const JWT_SECRET = requireEnv('JWT_SECRET');
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

async function main() {
  const db = await connect();
  const ideas = db.collection('ideas');

  // ================= API =================

  // Список ідей. Контакти повертаються ЛИШЕ адміну.
  app.get('/api/ideas', async (req, res) => {
    try {
      const cid = ensureClientId(req, res);
      const admin = isAdminReq(req);

      const rows = await ideas.find({}).sort({ ts: -1 }).toArray();

      const result = rows.map((r) => {
        const votedBy = r.votedBy || [];
        const item = {
          id: r.id,
          name: r.name || '',
          cat: r.cat,
          text: r.text,
          votes: r.votes,
          status: r.status,
          ts: r.ts,
          voted: votedBy.includes(cid),
        };
        // Контакт бачить тільки адмін
        if (admin) item.contact = r.contact || '';
        return item;
      });

      res.json(result);
    } catch (e) {
      console.error('Помилка отримання ідей:', e);
      res.status(500).json({ error: 'Внутрішня помилка сервера' });
    }
  });

  // Створення нової ідеї
  app.post('/api/ideas', submitLimiter, async (req, res) => {
    try {
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

      await ideas.insertOne({
        id, name, cat, text, contact,
        votes: 1,
        votedBy: [cid],
        status: 'нова',
        ts,
      });

      res.status(201).json({ id, name, cat, text, votes: 1, status: 'нова', ts, voted: true });
    } catch (e) {
      console.error('Помилка створення ідеї:', e);
      res.status(500).json({ error: 'Внутрішня помилка сервера' });
    }
  });

  // Голосування (toggle), атомарно через findOneAndUpdate
  app.post('/api/ideas/:id/vote', async (req, res) => {
    try {
      const cid = ensureClientId(req, res);
      const id = req.params.id;
      const existing = await ideas.findOne({ id });
      if (!existing) return res.status(404).json({ error: 'Ідею не знайдено' });

      const hasVoted = (existing.votedBy || []).includes(cid);
      const update = hasVoted
        ? { $pull: { votedBy: cid }, $inc: { votes: -1 } }
        : { $addToSet: { votedBy: cid }, $inc: { votes: 1 } };

      const result = await ideas.findOneAndUpdate({ id }, update, { returnDocument: 'after' });
      const updated = result.value || result;
      res.json({ votes: Math.max(0, updated.votes), voted: !hasVoted });
    } catch (e) {
      console.error('Помилка голосування:', e);
      res.status(500).json({ error: 'Внутрішня помилка сервера' });
    }
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
  app.patch('/api/ideas/:id', requireAdmin, async (req, res) => {
    try {
      const allowed = ['нова', 'на розгляді', 'прийнято'];
      const status = ((req.body && req.body.status) || '').toString();
      if (!allowed.includes(status)) return res.status(400).json({ error: 'Невірний статус' });
      const result = await ideas.updateOne({ id: req.params.id }, { $set: { status } });
      if (result.matchedCount === 0) return res.status(404).json({ error: 'Ідею не знайдено' });
      res.json({ ok: true, status });
    } catch (e) {
      console.error('Помилка оновлення статусу:', e);
      res.status(500).json({ error: 'Внутрішня помилка сервера' });
    }
  });

  // Адмін: видалити ідею
  app.delete('/api/ideas/:id', requireAdmin, async (req, res) => {
    try {
      await ideas.deleteOne({ id: req.params.id });
      res.json({ ok: true });
    } catch (e) {
      console.error('Помилка видалення:', e);
      res.status(500).json({ error: 'Внутрішня помилка сервера' });
    }
  });

  // ---------- Статика (фронтенд) ----------
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Сервер запущено на порту ${PORT}`);
  });
}

main().catch((e) => {
  console.error('Не вдалося запустити сервер:', e);
  process.exit(1);
});
