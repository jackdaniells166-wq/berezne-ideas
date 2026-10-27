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

// Таймаут вибору сервера скорочено (дефолт драйвера — 30 с), щоб невдала
// спроба швидко завершувалась і connectWithRetry у server.js міг повторити її.
const SERVER_SELECTION_TIMEOUT_MS = Number(process.env.MONGODB_TIMEOUT_MS) || 10000;

let client = null;
let db = null;

async function connect() {
  if (db) return db;

  // Новий клієнт на кожну спробу: після невдалого connect() старий краще не перевикористовувати.
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS });
  try {
    await client.connect();
    const database = client.db(MONGODB_DB);

    // Індекси створюються один раз, ідемпотентно — safe re-run при кожному старті.
    await database.collection('ideas').createIndex({ ts: -1 });
    await database.collection('ideas').createIndex({ cat: 1 });

    db = database;
    console.log(`Підключено до MongoDB: ${MONGODB_DB}`);
    return db;
  } catch (e) {
    await client.close().catch(() => {});
    client = null;
    throw e;
  }
}

module.exports = { connect };
