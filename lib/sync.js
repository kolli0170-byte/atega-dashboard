// Синхронизация всех источников.
// Аналогия: диспетчер склада раз в N минут обходит всех поставщиков.
// Если у поставщика нет ключа (.env) — к нему не идём. Если поставщик ответил ошибкой —
// записываем понятную причину в db.status, остальные источники продолжают работать.
import { db, save, getSettings } from './db.js';
import { ingest } from './documents.js';
import * as wb from './connectors/wb.js';
import * as wbads from './connectors/wbads.js';
import * as ozon from './connectors/ozon.js';
import * as ozonperf from './connectors/ozonperf.js';
import * as yandex from './connectors/yandex.js';
import * as amocrm from './connectors/amocrm.js';
import * as bitrix from './connectors/bitrix.js';
import * as tbank from './connectors/tbank.js';
import * as tochka from './connectors/tochka.js';
import * as imap from './connectors/imap.js';
import * as telegram from './connectors/telegram.js';
import * as diadok from './connectors/diadok.js';
import * as wbdocs from './connectors/wbdocs.js';
import { aiEnabled } from './ai.js';

// Реестр источников: имя для интерфейса, функция «включён ли», какие переменные нужны
export const SOURCES = {
  wb:       { name: 'Wildberries',      group: 'Маркетплейсы', enabled: wb.enabled,       env: ['WB_TOKEN'] },
  ozon:     { name: 'Ozon Seller',      group: 'Маркетплейсы', enabled: ozon.enabled,     env: ['OZON_CLIENT_ID', 'OZON_API_KEY'] },
  ym:       { name: 'Яндекс Маркет',    group: 'Маркетплейсы', enabled: yandex.enabled,   env: ['YM_API_KEY', 'YM_CAMPAIGN_ID'] },
  wbads:    { name: 'WB Продвижение',   group: 'Реклама',      enabled: wbads.enabled,    env: ['WB_ADS_TOKEN или WB_TOKEN'] },
  ozonperf: { name: 'Ozon Performance', group: 'Реклама',      enabled: ozonperf.enabled, env: ['OZON_PERF_CLIENT_ID', 'OZON_PERF_CLIENT_SECRET'] },
  amocrm:   { name: 'amoCRM',           group: 'CRM',          enabled: amocrm.enabled,   env: ['AMO_SUBDOMAIN', 'AMO_TOKEN'] },
  bitrix:   { name: 'Битрикс24',        group: 'CRM',          enabled: bitrix.enabled,   env: ['BITRIX_WEBHOOK'] },
  tbank:    { name: 'Т-Банк Бизнес',    group: 'Банки',        enabled: tbank.enabled,    env: ['TBANK_TOKEN'] },
  tochka:   { name: 'Точка',            group: 'Банки',        enabled: tochka.enabled,   env: ['TOCHKA_TOKEN'] },
  imap:     { name: 'Почта (IMAP)',     group: 'Документы',    enabled: imap.enabled,     env: ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASSWORD'] },
  telegram: { name: 'Telegram-бот',     group: 'Документы',    enabled: telegram.enabled, env: ['TELEGRAM_BOT_TOKEN'] },
  diadok:   { name: 'Диадок (ЭДО)',     group: 'Документы',    enabled: diadok.enabled,   env: ['DIADOC_API_KEY', 'DIADOC_LOGIN', 'DIADOC_PASSWORD'] },
  wbdocs:   { name: 'Документы WB',     group: 'Документы',    enabled: wbdocs.enabled,   env: ['WB_TOKEN (категория «Документы»)'] },
  claude:   { name: 'Claude API',       group: 'ИИ',           enabled: aiEnabled,        env: ['ANTHROPIC_API_KEY'] }
};

// CRM — одна из двух: amoCRM главнее, если заданы обе
export const crm = () => (amocrm.enabled() ? amocrm : bitrix.enabled() ? bitrix : null);

let running = null;

// Запуск одного коннектора с записью статуса
async function run(key, fn) {
  if (!SOURCES[key].enabled()) return null;
  const started = Date.now();
  try {
    const result = await fn();
    db.status[key] = { ok: true, at: new Date().toISOString(), ms: Date.now() - started, error: null };
    return result;
  } catch (e) {
    console.error(`[sync] ${key}: ${e.message}`);
    db.status[key] = { ok: false, at: new Date().toISOString(), error: e.message };
    return null;
  } finally {
    save();
  }
}

// Полная синхронизация. Если уже идёт — возвращаем тот же промис (не запускаем вторую).
export function syncAll() {
  if (running) return running;
  running = (async () => {
    db.syncing = true;
    // Источники независимы — запускаем параллельно, каждый со своей обработкой ошибок
    await Promise.all([
      run('wb', wb.sync).then((r) => r && (db.raw.wb = r)),
      run('ozon', ozon.sync).then((r) => r && (db.raw.ozon = r)),
      run('ym', yandex.sync).then((r) => r && (db.raw.ym = r)),
      run('wbads', wbads.sync).then((r) => r && (db.raw.wbads = r)),
      run('ozonperf', ozonperf.sync).then((r) => r && (db.raw.ozonperf = r)),
      run('amocrm', amocrm.sync).then((r) => r && (db.raw.amocrm = r)),
      run('bitrix', bitrix.sync).then((r) => r && (db.raw.bitrix = r)),
      run('tbank', tbank.sync).then((r) => r && (db.raw.tbank = r)),
      run('tochka', tochka.sync).then((r) => r && (db.raw.tochka = r)),
      // Документы: коннектор отдаёт файлы → общий конвейер ingest()
      run('imap', imap.sync).then((files) => files && ingest(files)),
      run('diadok', diadok.sync).then((files) => files && ingest(files)),
      run('wbdocs', wbdocs.sync).then((files) => files && ingest(files))
    ]);
    if (aiEnabled()) db.status.claude = { ok: true, at: new Date().toISOString(), error: db.status.claude?.error || null };
    db.lastSync = new Date().toISOString();
    db.syncing = false;
    save();
  })().finally(() => { running = null; });
  return running;
}

export const isSyncing = () => !!running;

// Telegram опрашиваем чаще (раз в 20 секунд), чтобы бот отвечал быстро
async function pollTelegram() {
  if (!telegram.enabled()) return;
  try {
    await telegram.poll(ingest);
    db.status.telegram = { ok: true, at: new Date().toISOString(), error: null };
  } catch (e) {
    db.status.telegram = { ok: false, at: new Date().toISOString(), error: e.message };
  }
}

// Расписание: полная синхронизация раз в settings.syncMinutes (по умолчанию 30 минут)
export function startScheduler() {
  const minutes = Math.max(5, Number(getSettings().syncMinutes) || 30);
  const anyEnabled = Object.entries(SOURCES).some(([k, s]) => k !== 'claude' && s.enabled());
  if (anyEnabled) {
    // Первая синхронизация — через 3 секунды после старта
    setTimeout(() => syncAll(), 3000);
    setInterval(() => syncAll(), minutes * 60000);
  }
  setInterval(pollTelegram, 20000);
  console.log(`Синхронизация: раз в ${minutes} мин. Подключено источников: ${Object.values(SOURCES).filter((s) => s.enabled()).length}`);
}

// Сводка для страницы «Интеграции». Ключи НЕ отдаём — только «задан / не задан» и статус.
export function integrations() {
  return Object.entries(SOURCES).map(([key, s]) => ({
    key,
    name: s.name,
    group: s.group,
    enabled: s.enabled(),
    env: s.env,
    status: db.status[key] || null
  }));
}
