// Хранилище BrandOS: один JSON-файл data/db.json.
// Аналогия: это общая тетрадь команды. Все читают её из памяти (быстро),
// а на диск изменения переписываются с небольшой задержкой (debounce),
// чтобы десять правок подряд не превращались в десять записей файла.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './env.js';

// На Railway папка data/ должна лежать на постоянном диске (Volume).
// Railway сам задаёт RAILWAY_VOLUME_MOUNT_PATH, когда диск подключён.
export const DATA_DIR = path.resolve(
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data')
);
export const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(FILES_DIR, { recursive: true });

// Пустая структура базы — «чистая тетрадь»
function emptyDb() {
  return {
    raw: {},          // сырые нормализованные данные от коннекторов: raw.wb, raw.ozon, ...
    status: {},       // состояние каждого источника: { ok, at, error }
    lastSync: null,   // время последней полной синхронизации
    tasks: [],        // задачи команды
    deals: [],        // сделки (если CRM не подключена — живут здесь)
    documents: [],    // документы
    decisions: [],    // решения из Центра решений
    decisionLog: [],  // прошлые ответы владельца на решения (их учитывает ИИ)
    state: {}         // служебное: offset Telegram, последний UID почты и т.п.
  };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Дополняем недостающие поля, если база создана старой версией
    return { ...emptyDb(), ...parsed };
  } catch {
    return emptyDb();
  }
}

export const db = load();

let timer = null;
// Запись на диск «атомарно»: сначала во временный файл, потом переименование.
// Если сервер упадёт посреди записи — старый db.json останется целым.
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 300);
}

// Цифры бизнеса из settings.json. Читаем при каждом обращении,
// чтобы правки файла применялись без перезапуска сервера.
// Если в DATA_DIR лежит свой settings.json (на постоянном диске Railway) — он главнее.
export function getSettings() {
  const candidates = [path.join(DATA_DIR, 'settings.json'), path.join(ROOT, 'settings.json')];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        console.error(`settings.json не читается (${file}): ${e.message}`);
      }
    }
  }
  return {};
}

// ===== Мелкие помощники для дат и id =====

// Дата в формате YYYY-MM-DD (по UTC — так же отдают даты API маркетплейсов)
export const isoDay = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

// Дата N дней назад
export const daysAgo = (n) => new Date(Date.now() - n * 86400000);

// Короткий уникальный id: t_1a2b3c4d
export const uid = (prefix = 'id') => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Число из строки API: "1 234,50" → 1234.5 (Ozon Performance любит запятые)
export const num = (v) => {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};
