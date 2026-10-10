// Коннектор Ozon Performance (реклама Ozon). Отдельный кабинет и ОТДЕЛЬНЫЕ ключи —
// ключи Seller API сюда не подходят.
// Документация: https://docs.ozon.ru/api/performance
import { request } from '../http.js';
import { isoDay, daysAgo, num } from '../db.js';

const BASE = 'https://api-performance.ozon.ru';

export const enabled = () => !!(process.env.OZON_PERF_CLIENT_ID && process.env.OZON_PERF_CLIENT_SECRET);

// Токен живёт ~30 минут — кэшируем, чтобы не просить новый на каждый запрос
let cached = { token: null, until: 0 };
async function token() {
  if (cached.token && Date.now() < cached.until) return cached.token;
  const r = await request(`${BASE}/api/client/token`, {
    method: 'POST',
    source: 'Ozon Performance',
    body: { client_id: process.env.OZON_PERF_CLIENT_ID, client_secret: process.env.OZON_PERF_CLIENT_SECRET, grant_type: 'client_credentials' }
  });
  cached = { token: r.access_token, until: Date.now() + ((r.expires_in || 1800) - 60) * 1000 };
  return cached.token;
}

const STATE = { CAMPAIGN_STATE_RUNNING: 'идёт', CAMPAIGN_STATE_STOPPED: 'пауза', CAMPAIGN_STATE_INACTIVE: 'пауза', CAMPAIGN_STATE_FINISHED: 'завершена', CAMPAIGN_STATE_ARCHIVED: 'завершена' };

export async function sync() {
  const auth = () => ({ Authorization: `Bearer ${cached.token}` });
  await token();

  const list = await request(`${BASE}/api/client/campaign`, { headers: auth(), source: 'Ozon Performance' });
  const camps = (list?.list || []).filter((c) => c.state !== 'CAMPAIGN_STATE_ARCHIVED');
  if (!camps.length) return { campaigns: [] };

  // Статистика по дням за 30 дней по всем кампаниям
  const params = new URLSearchParams({ dateFrom: isoDay(daysAgo(30)), dateTo: isoDay() });
  for (const c of camps) params.append('campaignIds', c.id);
  await token();
  const stat = await request(`${BASE}/api/client/statistics/daily/json?${params}`, { headers: auth(), source: 'Ozon Performance', timeout: 60000 });

  const byId = new Map(camps.map((c) => [String(c.id), {
    mp: 'ozon', id: String(c.id), name: c.title || `Кампания ${c.id}`, status: STATE[c.state] || 'идёт',
    spend: 0, views: 0, clicks: 0, orders: 0, ordersSum: 0, articles: [], daily: []
  }]));

  // Числа могут прийти строками с запятой — num() это учитывает
  for (const row of stat?.rows || []) {
    const c = byId.get(String(row.id));
    if (!c) continue;
    const d = { date: String(row.date).slice(0, 10), spend: num(row.moneySpent), views: num(row.views), clicks: num(row.clicks), orders: num(row.orders), ordersSum: num(row.ordersMoney) };
    c.daily.push(d);
    c.spend += d.spend; c.views += d.views; c.clicks += d.clicks; c.orders += d.orders; c.ordersSum += d.ordersSum;
  }
  return { campaigns: [...byId.values()] };
}
