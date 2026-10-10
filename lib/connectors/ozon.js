// Коннектор Ozon Seller API: выручка по дням и по SKU, финансы (комиссии, логистика, к выплате), остатки.
// Документация: https://docs.ozon.ru/api/seller
// Авторизация: заголовки Client-Id и Api-Key. Все методы — POST с JSON.
import { request } from '../http.js';
import { isoDay, daysAgo, num, sleep } from '../db.js';

const BASE = 'https://api-seller.ozon.ru';

export const enabled = () => !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);

function post(path, body) {
  return request(BASE + path, {
    method: 'POST',
    body,
    headers: { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY },
    source: 'Ozon Seller',
    timeout: 60000
  });
}

// Итоги финансов за период. Комиссии и расходы приходят со знаком минус.
async function financeTotals(from, to) {
  const r = await post('/v3/finance/transaction/totals', {
    date: { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` },
    transaction_type: 'all'
  });
  const t = r?.result || {};
  const f = {
    accruals: num(t.accruals_for_sale),               // начислено за продажи
    commission: num(t.sale_commission),               // комиссия (минус)
    logistics: num(t.processing_and_delivery),        // логистика и обработка (минус)
    refunds: num(t.refunds_and_cancellations),        // возвраты и отмены (минус)
    services: num(t.services_amount),                 // услуги, в т.ч. продвижение (минус)
    compensation: num(t.compensation_amount),
    others: num(t.others_amount)
  };
  // К выплате = сумма всех строк (минусы уже со знаком)
  f.payout = Object.values(f).reduce((a, b) => a + b, 0);
  return f;
}

export async function sync() {
  const to = isoDay();
  const from60 = isoDay(daysAgo(60));
  const from28 = isoDay(daysAgo(28));

  // 1) Выручка и заказанные штуки по дням за 60 дней
  const daily = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const r = await post('/v1/analytics/data', {
      date_from: from60, date_to: to, metrics: ['revenue', 'ordered_units'], dimension: ['day'], limit: 1000, offset
    });
    const rows = r?.result?.data || [];
    for (const row of rows) {
      daily.push({ mp: 'ozon', date: row.dimensions?.[0]?.id, revenue: num(row.metrics?.[0]), units: num(row.metrics?.[1]) });
    }
    if (rows.length < 1000) break;
  }
  await sleep(1500);

  // 2) Выручка и штуки по SKU за 28 дней — для таблицы артикулов и дней остатка
  const bySku = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const r = await post('/v1/analytics/data', {
      date_from: from28, date_to: to, metrics: ['revenue', 'ordered_units'], dimension: ['sku'], limit: 1000, offset
    });
    const rows = r?.result?.data || [];
    for (const row of rows) {
      bySku.push({ sku: String(row.dimensions?.[0]?.id), name: row.dimensions?.[0]?.name || '', revenue: num(row.metrics?.[0]), units: num(row.metrics?.[1]) });
    }
    if (rows.length < 1000) break;
  }
  await sleep(1500);

  // 3) Финансы: текущие 30 дней и предыдущие 30 — для % к прошлому периоду
  const finance = await financeTotals(isoDay(daysAgo(30)), to);
  await sleep(1000);
  const financePrev = await financeTotals(isoDay(daysAgo(60)), isoDay(daysAgo(31)));
  await sleep(1000);

  // 4) Остатки по складам Ozon → сворачиваем по артикулу продавца (item_code)
  const r = await post('/v2/analytics/stock_on_warehouses', { limit: 1000, offset: 0, warehouse_type: 'ALL' });
  const byArticle = new Map();
  for (const row of r?.result?.rows || []) {
    const article = row.item_code || String(row.sku);
    const cur = byArticle.get(article) || { mp: 'ozon', article, sku: String(row.sku), name: row.item_name || article, qty: 0, inWay: 0 };
    cur.qty += num(row.free_to_sell_amount);
    cur.inWay += num(row.promised_amount);
    byArticle.set(article, cur);
  }

  return { daily, bySku, finance, financePrev, stocks: [...byArticle.values()], period: { from: from60, to } };
}
