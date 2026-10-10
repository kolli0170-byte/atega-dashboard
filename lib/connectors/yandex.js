// Коннектор Яндекс Маркета (Partner API): заказы с ценами и комиссиями за 60 дней, остатки.
// Документация: https://yandex.ru/dev/market/partner-api/doc/ru/
// Авторизация: заголовок Api-Key. Токен создаётся в кабинете продавца:
// Настройки → API и модули → Токены авторизации, доступ «Просмотр всех данных» (all-methods:read-only).
// Аналогия: Маркет присылает «чеки» заказов, а мы раскладываем их по дням и артикулам —
// в тот же формат, что у WB и Ozon, чтобы дальше все расчёты были общими.
import { request } from '../http.js';
import { isoDay, daysAgo, num, sleep } from '../db.js';

const BASE = 'https://api.partner.market.yandex.ru';

export const enabled = () => !!(process.env.YM_API_KEY && process.env.YM_CAMPAIGN_ID);

// Статусы, при которых заказ не принёс денег
const CANCELLED = new Set(['CANCELLED_BEFORE_PROCESSING', 'CANCELLED_IN_DELIVERY', 'CANCELLED_IN_PROCESSING', 'UNPAID', 'LOST']);
const RETURNED = new Set(['RETURNED', 'PARTIALLY_RETURNED']);

function post(path, body, query = {}) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString();
  return request(`${BASE}${path}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    body,
    headers: { 'Api-Key': process.env.YM_API_KEY.trim() },
    source: 'Яндекс Маркет',
    timeout: 60000
  });
}

// Цена для покупателя по строке заказа: total, иначе цена за штуку × количество
function itemRevenue(it) {
  const p = (it.prices || []).find((x) => x.type === 'BUYER');
  if (!p) return 0;
  return p.total != null ? num(p.total) : num(p.costPerItem) * num(it.count);
}

export async function sync() {
  const campaign = encodeURIComponent(process.env.YM_CAMPAIGN_ID.trim());
  const to = isoDay();
  const from = isoDay(daysAgo(60));

  // 1) Заказы за 60 дней (по дате создания). Постранично, до 200 штук на страницу.
  const orders = [];
  let pageToken = '';
  for (let page = 0; page < 200; page++) {
    const r = await post(`/v2/campaigns/${campaign}/stats/orders`, { dateFrom: from, dateTo: to }, { limit: 200, pageToken });
    for (const o of r?.result?.orders || []) {
      if (o.fake) continue; // тестовые заказы Маркета не считаем
      const items = (o.items || []).map((it) => ({
        article: it.shopSku || String(it.marketSku || ''),
        name: it.offerName || it.shopSku || '',
        units: num(it.count),
        revenue: itemRevenue(it)
      }));
      const revenue = items.reduce((a, x) => a + x.revenue, 0);
      // Комиссии Маркета (размещение, доставка, приём платежа…) — положительные суммы удержаний
      const commission = (o.commissions || []).reduce((a, c) => a + num(c.actual), 0);
      orders.push({
        mp: 'ym',
        id: String(o.id),
        date: String(o.creationDate).slice(0, 10),
        status: o.status,
        cancelled: CANCELLED.has(o.status),
        isReturn: RETURNED.has(o.status),
        revenue,
        commission,
        payout: revenue - commission,
        units: items.reduce((a, x) => a + x.units, 0),
        items
      });
    }
    pageToken = r?.result?.paging?.nextPageToken || '';
    if (!pageToken) break;
    await sleep(300);
  }

  // 2) Остатки по складам → сворачиваем по артикулу. Берём «доступно к продаже» (AVAILABLE), иначе годный товар (FIT).
  const byArticle = new Map();
  pageToken = '';
  for (let page = 0; page < 100; page++) {
    const r = await post(`/v2/campaigns/${campaign}/offers/stocks`, {}, { limit: 100, pageToken });
    for (const wh of r?.result?.warehouses || []) {
      for (const offer of wh.offers || []) {
        const st = offer.stocks || [];
        const qty = num(st.find((s) => s.type === 'AVAILABLE')?.count ?? st.find((s) => s.type === 'FIT')?.count);
        const cur = byArticle.get(offer.offerId) || { mp: 'ym', article: offer.offerId, name: offer.offerId, qty: 0, inWay: 0 };
        cur.qty += qty;
        byArticle.set(offer.offerId, cur);
      }
    }
    pageToken = r?.result?.paging?.nextPageToken || '';
    if (!pageToken) break;
    await sleep(300);
  }
  // Названия товаров для остатков подставляем из заказов
  const names = new Map(orders.flatMap((o) => o.items.map((i) => [i.article, i.name])));
  for (const s of byArticle.values()) s.name = names.get(s.article) || s.article;

  return { orders, stocks: [...byArticle.values()], period: { from, to } };
}
