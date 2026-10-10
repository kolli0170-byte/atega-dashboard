// BrandOS — сервер на чистом Node.js (без Express и других фреймворков).
// Отдаёт index.html и API. Ключи живут только в .env / переменных хостинга.
//
// Как устроен роутинг: таблица «метод + путь → функция». Аналогия — табличка
// на ресепшене: «бухгалтерия — 2 этаж, склад — 1 этаж». Запрос приходит,
// мы ищем подходящую строку и передаём ему управление.
import './lib/env.js'; // ПЕРВЫМ: загружает .env до того, как остальные модули прочитают process.env
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/env.js';
import { db, save, uid, FILES_DIR, getSettings, isoDay } from './lib/db.js';
import { syncAll, isSyncing, startScheduler, integrations, crm } from './lib/sync.js';
import { buildDashboard, buildAnalytics, snapshotForAI, crmData } from './lib/aggregate.js';
import { ingest } from './lib/documents.js';
import { aiEnabled, chat } from './lib/ai.js';
import * as decisions from './lib/decisions.js';
import * as auth from './lib/auth.js';

const PORT = Number(process.env.PORT) || 3000;
const INDEX = path.join(ROOT, 'index.html');

// ===== Помощники ответа =====
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin'
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

const fail = (res, status, message) => send(res, status, { error: message });

// Чтение тела запроса с ограничением размера (защита от «бесконечной» загрузки)
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Файл слишком большой'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Некорректный JSON'), { status: 400 }); }
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ===== Обработчики API =====

// Разрешённые поля задачи — всё остальное из запроса игнорируем
const TASK_FIELDS = ['title', 'status', 'priority', 'due', 'assignee', 'description', 'byAI', 'docId', 'decisionId'];
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj[f] !== undefined).map((f) => [f, obj[f]]));

async function upsertDeal(id, body) {
  const ext = crm();
  const data = crmData();
  if (!id) {
    // Новая сделка
    const deal = { id: uid('deal'), c: String(body.c || 'Новая сделка').slice(0, 200), sum: Number(body.sum) || 0, st: body.st || data.stages[0]?.id, src: body.src || 'Вручную', mgr: body.mgr || '', d: isoDay(), closed: null };
    if (ext) {
      deal.id = await ext.createDeal({ ...deal, pipelineId: data.pipelineId });
      deal.src = data.provider === 'amocrm' ? 'amoCRM' : 'Битрикс24';
      db.raw[data.provider === 'amocrm' ? 'amocrm' : 'bitrix'].deals.unshift(deal);
    } else db.deals.unshift(deal);
    save();
    return deal;
  }
  const deal = data.deals.find((d) => d.id === id);
  if (!deal) throw Object.assign(new Error('Сделка не найдена'), { status: 404 });
  // Перенос этапа на дашборде записывается обратно в CRM
  if (ext && body.st && body.st !== deal.st) await ext.moveDeal(id, body.st);
  if (ext && ((body.c && body.c !== deal.c) || (body.sum != null && Number(body.sum) !== deal.sum))) await ext.updateDeal(id, { c: body.c ?? deal.c, sum: body.sum ?? deal.sum });
  Object.assign(deal, pick(body, ['c', 'st', 'src', 'mgr']));
  if (body.sum != null) deal.sum = Number(body.sum) || 0;
  const stage = data.stages.find((s) => s.id === deal.st);
  deal.closed = stage?.won || stage?.lost ? deal.closed || isoDay() : null;
  save();
  return deal;
}

// Ответ ассистента без ИИ: честная сводка по цифрам
function fallbackAnswer() {
  const s = snapshotForAI();
  const rub = (n) => `${Math.round(n || 0).toLocaleString('ru-RU')} ₽`;
  const lines = ['ИИ не подключён (нет ANTHROPIC_API_KEY в настройках сервера), поэтому отвечаю короткой сводкой по данным:'];
  if (!s.demo.includes('kpi.revenue')) lines.push(`• Выручка за 30 дней: ${rub(s.kpi30d.revenue.value)}, прибыль (оценка): ${rub(s.kpi30d.profit.value)}, маржа ${s.kpi30d.margin.value}%.`);
  else lines.push('• Маркетплейсы не подключены — выручки и прибыли нет.');
  if (!s.demo.includes('kpi.cash')) lines.push(`• На счетах: ${rub(s.kpi30d.cash.value)}.`);
  if (s.cashflow?.gap) lines.push(`• Кассовый разрыв в прогнозе: ${s.cashflow.gap.date}, ${rub(s.cashflow.gap.amount)}.`);
  lines.push(`• Открытых задач: ${s.tasks.length}. Документов: ${s.documents.length}.`);
  return lines.join('\n');
}

const routes = [
  ['GET', /^\/api\/dashboard$/, async () => ({ mode: 'live', ...buildDashboard(), integrations: integrations(), ai: aiEnabled() })],
  ['GET', /^\/api\/analytics$/, async () => buildAnalytics()],
  ['GET', /^\/api\/integrations$/, async () => integrations()],
  ['GET', /^\/api\/sync$/, async () => ({ syncing: isSyncing(), lastSync: db.lastSync })],
  ['POST', /^\/api\/sync$/, async () => { syncAll(); return { syncing: true, lastSync: db.lastSync }; }],

  // --- Задачи ---
  ['GET', /^\/api\/tasks$/, async () => db.tasks],
  ['POST', /^\/api\/tasks$/, async (req) => {
    const body = await readJson(req);
    const t = { id: uid('t'), status: 'todo', priority: 'medium', createdAt: new Date().toISOString(), ...pick(body, TASK_FIELDS) };
    t.title = String(t.title || 'Новая задача').slice(0, 300);
    db.tasks.push(t); save(); return t;
  }],
  ['PUT', /^\/api\/tasks\/([\w-]+)$/, async (req, [id]) => {
    const t = db.tasks.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error('Задача не найдена'), { status: 404 });
    Object.assign(t, pick(await readJson(req), TASK_FIELDS), { updatedAt: new Date().toISOString() });
    save(); return t;
  }],
  ['DELETE', /^\/api\/tasks\/([\w-]+)$/, async (req, [id]) => { db.tasks = db.tasks.filter((x) => x.id !== id); save(); return { ok: true }; }],

  // --- Сделки (CRM) ---
  ['GET', /^\/api\/deals$/, async () => crmData()],
  ['POST', /^\/api\/deals$/, async (req) => upsertDeal(null, await readJson(req))],
  ['PUT', /^\/api\/deals\/([\w-]+)$/, async (req, [id]) => upsertDeal(id, await readJson(req))],
  ['DELETE', /^\/api\/deals\/([\w-]+)$/, async (req, [id]) => {
    if (crm()) throw Object.assign(new Error('Сделки из CRM удаляются в самой CRM'), { status: 400 });
    db.deals = db.deals.filter((d) => d.id !== id); save(); return { ok: true };
  }],

  // --- Документы ---
  ['GET', /^\/api\/documents$/, async () => db.documents],
  ['POST', /^\/api\/documents$/, async (req) => {
    // Ручная загрузка: тело — сам файл, имя — в заголовке X-File-Name (закодировано)
    const buffer = await readBody(req, 25 * 1024 * 1024);
    if (!buffer.length) throw Object.assign(new Error('Пустой файл'), { status: 400 });
    const name = decodeURIComponent(req.headers['x-file-name'] || 'документ');
    const [doc] = await ingest([{ source: 'Вручную', name, buffer, mime: req.headers['content-type'] || 'application/octet-stream', from: 'Загружено вручную', date: new Date().toISOString() }]);
    return doc;
  }],
  ['PUT', /^\/api\/documents\/([\w-]+)$/, async (req, [id]) => {
    const d = db.documents.find((x) => x.id === id);
    if (!d) throw Object.assign(new Error('Документ не найден'), { status: 404 });
    const body = await readJson(req);
    if (body.status) d.status = String(body.status);
    save(); return d;
  }],
  ['DELETE', /^\/api\/documents\/([\w-]+)$/, async (req, [id]) => {
    const d = db.documents.find((x) => x.id === id);
    if (d?.file) fs.rmSync(path.join(FILES_DIR, d.file), { force: true });
    db.documents = db.documents.filter((x) => x.id !== id); save(); return { ok: true };
  }],

  // --- ИИ-чат ---
  ['POST', /^\/api\/chat$/, async (req) => {
    const { messages = [] } = await readJson(req);
    if (!aiEnabled()) return { reply: fallbackAnswer(), ai: false };
    return { reply: await chat(messages, snapshotForAI()), ai: true };
  }],

  // --- Центр решений ---
  ['GET', /^\/api\/decisions$/, async () => decisions.listDecisions()],
  ['POST', /^\/api\/decisions\/recompute$/, async () => { await decisions.recompute(); return decisions.listDecisions(); }],
  ['POST', /^\/api\/decisions\/([\w-]+)\/accept$/, async (req, [id]) => decisions.accept(id)],
  ['POST', /^\/api\/decisions\/([\w-]+)\/postpone$/, async (req, [id]) => decisions.postpone(id, 3)],
  ['POST', /^\/api\/decisions\/([\w-]+)\/reject$/, async (req, [id]) => decisions.reject(id, String((await readJson(req)).reason || '').slice(0, 500))]
];

// ===== Главный обработчик =====
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // Проверка живости для Railway — без пароля
    if (p === '/healthz') return send(res, 200, { ok: true });

    // На хостинге без пароля дашборд не открываем вообще
    if (auth.onHosting() && !auth.authEnabled()) {
      return p.startsWith('/api/') ? fail(res, 503, 'Не задан APP_PASSWORD') : send(res, 503, auth.loginPage({ setup: true, company: getSettings().companyName }));
    }

    // --- Вход и выход ---
    if (p === '/login' && req.method === 'GET') return send(res, 200, auth.loginPage({ company: getSettings().companyName }));
    if (p === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (auth.tooManyAttempts(ip)) return send(res, 429, auth.loginPage({ error: 'Слишком много попыток. Подождите 15 минут.' }));
      const form = new URLSearchParams((await readBody(req, 10000)).toString('utf8'));
      if (auth.checkPassword(form.get('password') || '')) {
        res.writeHead(303, { Location: '/', 'Set-Cookie': auth.sessionCookie(req) });
        return res.end();
      }
      auth.recordFail(ip);
      return send(res, 401, auth.loginPage({ error: 'Неверный пароль.', company: getSettings().companyName }));
    }
    if (p === '/logout') {
      res.writeHead(303, { Location: '/login', 'Set-Cookie': auth.clearCookie() });
      return res.end();
    }

    // --- Всё остальное — только после входа ---
    if (!auth.isAuthed(req)) {
      if (p.startsWith('/api/')) return fail(res, 401, 'Нужно войти');
      res.writeHead(303, { Location: '/login' });
      return res.end();
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(INDEX));
    }

    // Скачивание файла документа
    const fileMatch = p.match(/^\/api\/documents\/([\w-]+)\/file$/);
    if (req.method === 'GET' && fileMatch) {
      const d = db.documents.find((x) => x.id === fileMatch[1]);
      if (!d) return fail(res, 404, 'Документ не найден');
      const filePath = path.join(FILES_DIR, path.basename(d.file));
      if (!fs.existsSync(filePath)) return fail(res, 404, 'Файл не найден на диске');
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': d.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(d.name)}` });
      return fs.createReadStream(filePath).pipe(res);
    }

    for (const [method, re, handler] of routes) {
      const m = p.match(re);
      if (m && req.method === method) {
        const result = await handler(req, m.slice(1));
        if (result == null) return fail(res, 404, 'Не найдено');
        return send(res, 200, result);
      }
    }
    fail(res, 404, 'Не найдено');
  } catch (e) {
    console.error(`${req.method} ${p}:`, e.message);
    fail(res, e.status || 500, e.message || 'Ошибка сервера');
  }
});

server.listen(PORT, () => {
  console.log(`BrandOS запущен: http://localhost:${PORT}`);
  if (!auth.authEnabled()) console.log(auth.onHosting() ? 'ВНИМАНИЕ: не задан APP_PASSWORD — дашборд закрыт до настройки.' : 'Пароль не задан (APP_PASSWORD) — локально вход открыт.');
  startScheduler();
  decisions.startDecisionScheduler();
});
