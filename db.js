'use strict';

const { MongoClient } = require('mongodb');

// Обов'язкові змінні середовища. Якщо чогось бракує — сервер падає
// одразу з чіткою помилкою, а не тихо стартує в зламаному стані.
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Відсутня обов'язкова змінна середовища: ${name}. Сервер не запущено.`);
    process.exit(1);
  }
  return v;
}

const MONGODB_URI = requireEnv('MONGODB_URI');
const MONGODB_DB = process.env.MONGODB_DB || 'berezne';

const client = new MongoClient(MONGODB_URI);
let db = null;

async function connect() {
  if (db) return db;
  await client.connect();
  db = client.db(MONGODB_DB);

  // Індекси створюються один раз, ідемпотентно — safe re-run при кожному старті.
  await db.collection('ideas').createIndex({ ts: -1 });
  await db.collection('ideas').createIndex({ cat: 1 });

  console.log(`Підключено до MongoDB: ${MONGODB_DB}`);
  return db;
}

module.exports = { connect };
