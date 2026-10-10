// Проверка расчётов на тестовых данных в формате ответов API.
// Работает во ВРЕМЕННОЙ папке — настоящий data/db.json не трогается.
// Запуск: npm run test:calc
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 1) Окружение: временная папка данных и «фальшивые» ключи, чтобы коннекторы считались включёнными
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brandos-test-'));
Object.assign(process.env, {
  DATA_DIR: tmp, WB_TOKEN: 'test', OZON_CLIENT_ID: 'test', OZON_API_KEY: 'test', TBANK_TOKEN: 'test', ANTHROPIC_API_KEY: ''
});

const { db, isoDay, daysAgo } = await import('../lib/db.js');
const { buildDashboard, buildAnalytics } = await import('../lib/aggregate.js');
const { ruleDecisions, recompute, accept, listDecisions } = await import('../lib/decisions.js');
const { ingest } = await import('../lib/documents.js');

// 2) Тестовые данные. Цифры подобраны так, чтобы ожидаемый результат легко посчитать на бумаге.
const sales = [];
for (let i = 0; i < 60; i++) {
  const date = isoDay(daysAgo(i));
  for (let k = 0; k < 10; k++) sales.push({ mp: 'wb', date, article: 'A1', nmId: 1, name: 'Когтеточка', revenue: 1000, payout: 650, units: 1, isReturn: false });
  for (let k = 0; k < 4; k++) sales.push({ mp: 'wb', date, article: 'A2', nmId: 2, name: 'Домик', revenue: 2500, payout: 1700, units: 1, isReturn: false });
  // Каждый 5-й день — один возврат A1 (отрицательная выручка)
  if (i % 5 === 0) sales.push({ mp: 'wb', date, article: 'A1', nmId: 1, name: 'Когтеточка', revenue: -1000, payout: -650, units: -1, isReturn: true });
}
db.raw.wb = {
  sales,
  orders: sales.filter((s) => !s.isReturn).map((s) => ({ mp: 'wb', date: s.date, article: s.article, sum: s.revenue, cancel: false })),
  stocks: [{ mp: 'wb', article: 'A1', nmId: 1, name: 'Когтеточка', qty: 100, inWay: 0 }, { mp: 'wb', article: 'A2', nmId: 2, name: 'Домик', qty: 500, inWay: 0 }]
};
db.raw.ozon = {
  daily: Array.from({ length: 60 }, (_, i) => ({ mp: 'ozon', date: isoDay(daysAgo(i)), revenue: 50000, units: 20 })),
  bySku: [{ sku: '111', name: 'Лежанка', revenue: 1400000, units: 560 }],
  finance: { accruals: 1500000, commission: -300000, logistics: -150000, refunds: -20000, services: -10000, compensation: 0, others: 0, payout: 1020000 },
  financePrev: { accruals: 1400000, commission: -280000, logistics: -140000, refunds: -20000, services: -10000, compensation: 0, others: 0, payout: 950000 },
  stocks: [{ mp: 'ozon', article: 'OZ1', sku: '111', name: 'Лежанка', qty: 2000, inWay: 0 }]
};
db.raw.wbads = { campaigns: [] };
db.raw.tbank = { accounts: [{ bank: 'Т-Банк', number: '1', name: 'Счёт', currency: 'RUB', balance: 500000 }], ops: [{ bank: 'Т-Банк', date: isoDay(daysAgo(2)), amount: 100000, party: 'WB', purpose: 'выплата' }] };
// Реклама WB: одна нормальная кампания и одна с ДРР 40%
process.env.WB_ADS_TOKEN = 'test';
db.raw.wbads = { campaigns: [
  { mp: 'wb', id: '1', name: 'Нормальная', status: 'идёт', spend: 30000, views: 100000, clicks: 3000, orders: 300, ordersSum: 300000, articles: ['2'], daily: [] },
  { mp: 'wb', id: '2', name: 'Дорогая', status: 'идёт', spend: 20000, views: 50000, clicks: 500, orders: 20, ordersSum: 50000, articles: ['1'], daily: [] }
] };

// 3) Считаем и сверяем
const D = buildDashboard();
const A = buildAnalytics();
const rub = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;

// Выручка за 30 дней: WB 30×20 000 − 6 возвратов × 1 000 = 594 000; Ozon 30×50 000 = 1 500 000
assert.equal(D.kpi.revenue.value, 594000 + 1500000, 'выручка');
// Выплаты: WB 30×13 300 − 6×650 = 395 100; Ozon из финансов 1 020 000
// Себестоимость 38%: (594 000 + 1 500 000)×0,38 = 795 720; постоянные 450 000; реклама 50 000
const expectedProfit = 395100 + 1020000 - 795720 - 450000 - 50000;
assert.equal(D.kpi.profit.value, expectedProfit, 'прибыль');
assert.equal(D.kpi.cash.value, 500000, 'деньги на счетах');
// ДРР WB: 50 000 / 594 000 = 8,4%
assert.equal(D.channels.find((c) => c.key === 'wb').drr, 8.4, 'ДРР WB');
// Дни остатка A1: за 28 дней продано 280 − 6 возвратов = 274 шт → 9,79/день → 100 шт хватит на 10 дней
const a1 = A.articles.find((a) => a.article === 'A1');
assert.equal(a1.days, 10, 'дни остатка A1');
// Кампания с ДРР 40% и артикул на исходе должны попасть в решения
const rules = ruleDecisions();
assert.ok(rules.some((d) => d.key === 'stock:wb:A1'), 'решение о дозаказе A1');
assert.ok(rules.some((d) => d.key === 'ads:wb:2' && d.title.startsWith('Остановить')), 'решение остановить кампанию');
// Блоки без источника помечены как демо
assert.ok(D.demo.includes('supplies') && D.demo.includes('traffic'), 'демо-блоки');
assert.ok(!D.demo.includes('kpi.revenue') && !D.demo.includes('kpi.cash'), 'живые блоки не помечены демо');

// Документы без ИИ: счёт → задача «оплатить»
const [doc] = await ingest([{ source: 'Вручную', name: 'Счёт №15 ООО Ромашка.pdf', buffer: Buffer.from('%PDF-1.4 test'), mime: 'application/pdf', from: 'тест', date: new Date().toISOString() }]);
assert.equal(doc.ai.type, 'Счёт');
assert.ok(db.tasks.some((t) => t.docId === doc.id && t.title.startsWith('Оплатить')), 'задача на оплату');

// Центр решений: пересчёт и «Принять» превращает шаги в задачи
await recompute();
const first = listDecisions().decisions.find((d) => d.key === 'stock:wb:A1');
accept(first.id);
assert.equal(db.tasks.filter((t) => t.decisionId === first.id).length, first.steps.length, 'шаги стали задачами');

// ===== Яндекс Маркет: добавляем канал и проверяем, что всё выросло ровно на его вклад =====
// Каждый день: заказ на 3 000 ₽ (комиссия 600 ₽, 2 шт), отменённый заказ на 5 000 ₽ (не считается),
// каждый 10-й день — полностью возвращённый заказ на 1 000 ₽ (не даёт выручки, но считается возвратом)
process.env.YM_API_KEY = 'test'; process.env.YM_CAMPAIGN_ID = '1';
const ymOrders = [];
for (let i = 0; i < 60; i++) {
  const date = isoDay(daysAgo(i));
  ymOrders.push({ mp: 'ym', id: `y${i}`, date, status: 'DELIVERED', cancelled: false, isReturn: false, revenue: 3000, commission: 600, payout: 2400, units: 2, items: [{ article: 'YM1', name: 'Гамак', units: 2, revenue: 3000 }] });
  ymOrders.push({ mp: 'ym', id: `c${i}`, date, status: 'CANCELLED_IN_PROCESSING', cancelled: true, isReturn: false, revenue: 5000, commission: 0, payout: 5000, units: 1, items: [{ article: 'YM1', name: 'Гамак', units: 1, revenue: 5000 }] });
  if (i % 10 === 0) ymOrders.push({ mp: 'ym', id: `r${i}`, date, status: 'RETURNED', cancelled: false, isReturn: true, revenue: 1000, commission: 0, payout: 1000, units: 1, items: [{ article: 'YM1', name: 'Гамак', units: 1, revenue: 1000 }] });
}
db.raw.ym = { orders: ymOrders, stocks: [{ mp: 'ym', article: 'YM1', name: 'Гамак', qty: 120, inWay: 0 }] };
const D2 = buildDashboard();
const A2 = buildAnalytics();
// Выручка Маркета за 30 дней: 30 × 3 000 = 90 000; выплаты 30 × 2 400 = 72 000; себестоимость 38% = 34 200
assert.equal(D2.kpi.revenue.value, D.kpi.revenue.value + 90000, 'выручка с Маркетом');
assert.equal(D2.kpi.profit.value, D.kpi.profit.value + 72000 - 34200, 'прибыль с Маркетом');
assert.equal(D2.channels.find((c) => c.key === 'ym').margin, 42, 'маржа Маркета');
assert.ok(D2.marketplaces.ym.connected && D2.marketplaces.ym.returns === 3, 'блок Маркета: 3 возврата за 30 дней');
// 28 дней × 2 шт = 56 шт → 2 шт в день → 120 шт хватит на 60 дней
assert.equal(A2.articles.find((a) => a.article === 'YM1').days, 60, 'дни остатка YM1');

// ===== Отчёты =====
const line = (rep, key) => rep.rows.find((r) => r.key === key).values;
const last = (arr) => arr[arr.length - 1];
// P&L по каналам: «Итого» прибыль до налога совпадает с прибылью на главной
assert.equal(last(line(D2.pnl, 'ebt')), D2.kpi.profit.value, 'P&L по каналам = прибыль на главной');
assert.equal(last(line(D2.pnl, 'revenue')), D2.kpi.revenue.value, 'P&L: выручка');
// ОПиУ: столбец «Итого» равен сумме месяцев, чистая прибыль = прибыль до налога − налог
const opRev = line(D2.opiu, 'revenue');
assert.equal(last(opRev), opRev.slice(0, -1).reduce((a, b) => a + b, 0), 'ОПиУ: итого = сумма месяцев');
assert.ok(line(D2.opiu, 'net').every((v, i) => Math.abs(v - (line(D2.opiu, 'ebt')[i] + line(D2.opiu, 'tax')[i])) <= 1), 'ОПиУ: чистая = до налога − налог');
// ДДС: остаток на начало + поток = остаток на конец; выплата WB распознана как «Выплаты маркетплейсов»
assert.equal(last(line(D2.dds, 'open')) + last(line(D2.dds, 'net')), last(line(D2.dds, 'close')), 'ДДС сходится');
assert.equal(last(line(D2.dds, 'mp_in')), 100000, 'ДДС: выплата WB по статье маркетплейсов');
// РНП: сегодня у Маркета 2 шт + 1 шт возвращённого заказа, 1 возврат; отменённый не считается
const rnpToday = D2.rnp.days.at(-1);
assert.equal(rnpToday.ym.orders, 3, 'РНП: заказы Маркета сегодня');
assert.equal(rnpToday.ym.returns, 1, 'РНП: возвраты Маркета сегодня');
assert.deepEqual(D2.rnp.channels, ['wb', 'ozon', 'ym'], 'РНП: каналы');
// Налоги: доход текущего квартала посчитан, взносов в тестовой выписке нет
const qNow = D2.tax.quarters[Math.floor(new Date().getMonth() / 3)];
assert.ok(qNow.income > 0 && qNow.contributions === 0, 'налоги: доход квартала');

console.log('Все проверки пройдены.\n');
console.log('Выручка за 30 дней    ', rub(D.kpi.revenue.value), `(${D.kpi.revenue.delta?.toFixed(1)}% к прошлым 30 дням)`);
console.log('Выплаты маркетплейсов ', rub(D.finance.payout));
console.log('Себестоимость         ', rub(D.finance.cogs));
console.log('Чистая прибыль        ', rub(D.kpi.profit.value), `маржа ${D.kpi.margin.value}%`);
console.log('Маржа / ДРР по каналам', D.channels.map((c) => `${c.name}: ${c.margin}% / ${c.drr}%`).join(', '));
console.log('План месяца           ', `${rub(D.plan.fact)} из ${rub(D.plan.plan)}, прогноз ${rub(D.plan.forecast)}`);
console.log('Прогноз денег         ', `сейчас ${rub(D.cashflow.start)}, через 30 дней ${rub(D.cashflow.end)}`, D.cashflow.gap ? `— разрыв ${D.cashflow.gap.date}: ${rub(D.cashflow.gap.amount)} (${D.cashflow.gap.reason})` : '— разрывов нет');
console.log('Склад                 ', A.articles.map((a) => `${a.article}: ${a.days ?? '—'} дн.`).join(', '));
console.log('Решения по правилам   ', rules.map((d) => `[${d.urgency}] ${d.title}`).join('\n                        '));
console.log('С Яндекс Маркетом     ', `выручка ${rub(D2.kpi.revenue.value)}, прибыль ${rub(D2.kpi.profit.value)}`);
console.log('ОПиУ, чистая прибыль  ', D2.opiu.columns.map((c, i) => `${c.label}${c.note ? ` (${c.note})` : ''}: ${rub(line(D2.opiu, 'net')[i])}`).join('; '));
console.log('ДДС                   ', `начало ${rub(last(line(D2.dds, 'open')))}, поток ${rub(last(line(D2.dds, 'net')))}, конец ${rub(last(line(D2.dds, 'close')))}`);

// Ждём отложенную запись базы и удаляем временную папку
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(tmp, { recursive: true, force: true });
