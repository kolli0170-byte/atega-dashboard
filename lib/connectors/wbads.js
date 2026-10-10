// Коннектор рекламы Wildberries (Продвижение): кампании, расход, показы, клики, заказы.
// Документация: https://dev.wildberries.ru (раздел «Продвижение»)
// Токен: WB_ADS_TOKEN, а если его нет — общий WB_TOKEN (у него должна быть отмечена категория «Продвижение»).
import { request } from '../http.js';
import { isoDay, daysAgo, num, sleep } from '../db.js';

const ADV = 'https://advert-api.wildberries.ru';
const token = () => process.env.WB_ADS_TOKEN || process.env.WB_TOKEN;

export const enabled = () => !!token();

// Коды статусов кампаний WB → человекочитаемые
const STATUS = { 9: 'идёт', 11: 'пауза', 7: 'завершена', 4: 'готова к запуску' };

export async function sync() {
  const o = { headers: { Authorization: token() }, source: 'WB Продвижение', timeout: 60000 };

  // 1) Список кампаний по статусам
  const count = await request(`${ADV}/adv/v1/promotion/count`, o);
  const monthAgo = Date.now() - 31 * 86400000;
  const ids = [];
  for (const group of count?.adverts || []) {
    if (![9, 11, 7].includes(group.status)) continue;
    for (const a of group.advert_list || []) {
      // Завершённые берём, только если они менялись за последний месяц
      if (group.status === 7 && new Date(a.changeTime).getTime() < monthAgo) continue;
      ids.push({ id: a.advertId, status: group.status });
    }
  }
  if (!ids.length) return { campaigns: [] };

  // 2) Названия кампаний (необязательно — если метод упадёт, назовём по id)
  const names = new Map();
  try {
    await sleep(1000);
    const info = await request(`${ADV}/adv/v1/promotion/adverts`, { ...o, method: 'POST', body: ids.map((x) => x.id).slice(0, 50) });
    for (const a of Array.isArray(info) ? info : []) names.set(a.advertId, a.name);
  } catch { /* не критично */ }

  // 3) Статистика пачками по 50 кампаний за 30 дней
  const begin = isoDay(daysAgo(30));
  const end = isoDay();
  const stats = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    if (i > 0) await sleep(61000); // строгий лимит метода — пауза между пачками
    let rows;
    try {
      rows = await request(`${ADV}/adv/v3/fullstats?ids=${batch.map((b) => b.id).join(',')}&beginDate=${begin}&endDate=${end}`, o);
    } catch (e) {
      // Запасной вариант — старый POST /adv/v2/fullstats
      if (e.status !== 404 && e.status !== 400) throw e;
      rows = await request(`${ADV}/adv/v2/fullstats`, {
        ...o, method: 'POST', body: batch.map((b) => ({ id: b.id, interval: { begin, end } }))
      });
    }
    stats.push(...(Array.isArray(rows) ? rows : []));
  }

  // Нормализуем в формат BrandOS: {mp, id, name, status, spend, views, clicks, orders, ordersSum, articles, daily}
  const campaigns = stats.map((s) => {
    const meta = ids.find((x) => x.id === s.advertId) || {};
    const articles = new Set();
    const daily = (s.days || []).map((d) => {
      for (const app of d.apps || []) for (const nm of app.nm || app.nms || []) articles.add(String(nm.nmId));
      return { date: String(d.date).slice(0, 10), spend: num(d.sum), views: num(d.views), clicks: num(d.clicks), orders: num(d.orders), ordersSum: num(d.sum_price) };
    });
    return {
      mp: 'wb',
      id: String(s.advertId),
      name: names.get(s.advertId) || `Кампания ${s.advertId}`,
      status: STATUS[meta.status] || 'идёт',
      spend: num(s.sum),
      views: num(s.views),
      clicks: num(s.clicks),
      orders: num(s.orders),
      ordersSum: num(s.sum_price),
      articles: [...articles], // здесь nmId, сопоставляем с артикулами в aggregate.js
      daily
    };
  });
  return { campaigns };
}
