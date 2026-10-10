// Коннектор Wildberries — Statistics API: продажи, возвраты, заказы, остатки за 60 дней.
// Документация: https://dev.wildberries.ru
// Авторизация: заголовок Authorization: <токен> (без слова Bearer).
// Лимит строгий (~1 запрос в минуту на метод), поэтому синхронизация не чаще раза в 30 минут.
import { request } from '../http.js';
import { isoDay, daysAgo, num, sleep } from '../db.js';

const STAT = 'https://statistics-api.wildberries.ru';

export const enabled = () => !!process.env.WB_TOKEN;
const headers = () => ({ Authorization: process.env.WB_TOKEN });
const opts = { headers: undefined, source: 'Wildberries', timeout: 60000 };

export async function sync() {
  const from = isoDay(daysAgo(60));
  const o = { ...opts, headers: headers() };

  // 1) Продажи и возвраты. saleID на «S» — продажа, на «R» — возврат.
  const salesRaw = await request(`${STAT}/api/v1/supplier/sales?dateFrom=${from}`, o);
  await sleep(1000);
  // 2) Заказы (в т.ч. отменённые)
  const ordersRaw = await request(`${STAT}/api/v1/supplier/orders?dateFrom=${from}`, o);
  await sleep(1000);
  // 3) Остатки на складах WB
  const stocksRaw = await request(`${STAT}/api/v1/supplier/stocks?dateFrom=2019-06-20T00:00:00`, o);

  // Нормализуем в общий формат BrandOS: {date, article, revenue, payout}
  // Возврат — отрицательная выручка и отрицательная выплата.
  const sales = (Array.isArray(salesRaw) ? salesRaw : []).map((r) => {
    const isReturn = String(r.saleID || '').startsWith('R');
    const sign = isReturn ? -1 : 1;
    return {
      mp: 'wb',
      date: String(r.date || '').slice(0, 10),
      article: r.supplierArticle || String(r.nmId || ''),
      nmId: r.nmId,
      name: r.subject || r.supplierArticle || '',
      revenue: sign * Math.abs(num(r.priceWithDisc)),
      payout: sign * Math.abs(num(r.forPay)),
      units: sign,
      isReturn
    };
  });

  const orders = (Array.isArray(ordersRaw) ? ordersRaw : []).map((r) => ({
    mp: 'wb',
    date: String(r.date || '').slice(0, 10),
    article: r.supplierArticle || String(r.nmId || ''),
    sum: num(r.priceWithDisc || r.totalPrice),
    cancel: !!r.isCancel
  }));

  // Остатки приходят построчно по складам — сворачиваем по артикулу
  const byArticle = new Map();
  for (const r of Array.isArray(stocksRaw) ? stocksRaw : []) {
    const article = r.supplierArticle || String(r.nmId || '');
    const cur = byArticle.get(article) || { mp: 'wb', article, nmId: r.nmId, name: r.subject || article, qty: 0, inWay: 0, price: 0 };
    cur.qty += num(r.quantity);
    cur.inWay += num(r.inWayToClient) + num(r.inWayFromClient);
    cur.price = num(r.Price) * (1 - num(r.Discount) / 100) || cur.price;
    byArticle.set(article, cur);
  }

  return { sales, orders, stocks: [...byArticle.values()], period: { from, to: isoDay() } };
}
