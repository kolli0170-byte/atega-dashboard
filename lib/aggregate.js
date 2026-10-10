// Все бизнес-расчёты BrandOS в одном месте.
// Принцип честности: блок считается ТОЛЬКО по подключённым источникам.
// Если источника нет — ключ блока попадает в список demo, и интерфейс
// показывает пример с пометкой «демо», а не выдуманные цифры под видом настоящих.
// Приблизительные расчёты попадают в список estimated (пометка «оценка»).
import { db, getSettings, isoDay, daysAgo } from './db.js';
import { SOURCES } from './sync.js';

// Данные источника — только если он включён в .env и уже что-то прислал
const live = (key) => (SOURCES[key]?.enabled() && db.raw[key]) || null;

const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const round = (n) => Math.round(Number(n) || 0);
const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

// Список дат от (сегодня − from) до (сегодня − to) включительно
function dayRange(from, to = 0) {
  const out = [];
  for (let i = from; i >= to; i--) out.push(isoDay(daysAgo(i)));
  return out;
}

const DEFAULT_STAGES = [
  { id: 'new', name: 'Новая' }, { id: 'contact', name: 'Контакт' }, { id: 'offer', name: 'КП отправлено' },
  { id: 'agree', name: 'Согласование' }, { id: 'won', name: 'Успешно', won: true }, { id: 'lost', name: 'Отказ', lost: true }
];

// CRM: внешняя (amoCRM / Битрикс24) или локальные сделки на сервере
export function crmData() {
  const ext = live('amocrm') || live('bitrix');
  if (ext) return { provider: ext.provider, stages: ext.stages, deals: ext.deals, pipelineId: ext.pipelineId };
  return { provider: 'local', stages: DEFAULT_STAGES, deals: db.deals };
}

// ====== Базовые ряды данных — общие для дашборда, аналитики и решений ======
function base() {
  const S = getSettings();
  const cogsPct = (Number(S.cogsPercent) || 0) / 100;
  const cogsBy = S.cogsByArticle || {}; // себестоимость за 1 шт. по артикулу, ₽

  const wb = live('wb');
  const oz = live('ozon');
  const ads = [...(live('wbads')?.campaigns || []), ...(live('ozonperf')?.campaigns || [])];
  const banks = [live('tbank'), live('tochka')].filter(Boolean);

  // Себестоимость строки: по артикулу (₽ за штуку), иначе % от выручки
  const cogsOf = (article, revenue, units) => (cogsBy[article] != null ? Number(cogsBy[article]) * units : revenue * cogsPct);

  // Ozon: доля «к выплате» от начислений — для оценки выплат по дням и артикулам
  const ozPayoutRatio = oz?.finance?.accruals > 0 ? oz.finance.payout / oz.finance.accruals : 0.7;

  // Ряд по дням за 60 дней: выручка, выплаты, себестоимость по каждому маркетплейсу
  const days = dayRange(59);
  const byDay = Object.fromEntries(days.map((d) => [d, { wb: 0, ozon: 0, wbPay: 0, ozPay: 0, wbCogs: 0, ozCogs: 0, cogs: 0, ads: 0, units: 0 }]));
  for (const s of wb?.sales || []) {
    const d = byDay[s.date];
    if (!d) continue;
    const c = cogsOf(s.article, s.revenue, s.units);
    d.wb += s.revenue; d.wbPay += s.payout; d.units += s.units;
    d.wbCogs += c; d.cogs += c;
  }
  // Себестоимость Ozon по дням — через средневзвешенную долю из таблицы SKU
  const ozSkuRev = sum(oz?.bySku || [], (x) => x.revenue);
  const skuToArticle = new Map((oz?.stocks || []).map((s) => [s.sku, s.article]));
  const ozCogsRatio = ozSkuRev > 0
    ? sum(oz.bySku, (x) => cogsOf(skuToArticle.get(x.sku) || x.sku, x.revenue, x.units)) / ozSkuRev
    : cogsPct;
  for (const r of oz?.daily || []) {
    const d = byDay[r.date];
    if (!d) continue;
    d.ozon += r.revenue; d.ozPay += r.revenue * ozPayoutRatio; d.units += r.units;
    d.ozCogs += r.revenue * ozCogsRatio; d.cogs += r.revenue * ozCogsRatio;
  }
  for (const c of ads) for (const x of c.daily || []) if (byDay[x.date]) byDay[x.date].ads += x.spend;

  // Банки: счета и операции
  const accounts = banks.flatMap((b) => b.accounts || []).filter((a) => ['RUB', '643', 'RUR'].includes(String(a.currency)));
  const ops = banks.flatMap((b) => b.ops || []).sort((a, b) => b.date.localeCompare(a.date));
  const cash = sum(accounts, (a) => a.balance);
  // Остаток на конец дня d: текущий остаток минус операции, прошедшие после d
  const balanceAt = (d) => cash - sum(ops.filter((o) => o.date > d), (o) => o.amount);

  return { S, cogsPct, cogsOf, wb, oz, ads, banks, accounts, ops, cash, balanceAt, byDay, days, ozPayoutRatio, ozCogsRatio, skuToArticle };
}

// Платежи по графику из settings.json на ближайшие N дней
function upcomingPayments(S, horizon = 45) {
  const out = [];
  const today = new Date(isoDay());
  for (let i = 0; i <= horizon; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    for (const p of S.payments || []) {
      const months = p.months; // например [1,4,7,10] для квартальных платежей
      if (Number(p.day) !== d.getUTCDate()) continue;
      if (Array.isArray(months) && !months.includes(d.getUTCMonth() + 1)) continue;
      out.push({ name: p.name, kind: p.kind || 'other', date: isoDay(d), amount: Number(p.amount) || 0, daysLeft: i });
    }
  }
  return out;
}

// ====== Главная + разделы ======
export function buildDashboard() {
  const B = base();
  const { S, wb, oz, ads, byDay, days, accounts, ops, cash, balanceAt } = B;
  const hasMP = !!(wb || oz);
  const hasBank = B.banks.length > 0;
  const hasAds = ads.length > 0;
  const demo = [];
  const estimated = [];

  const cur = days.slice(-30);
  const prev = days.slice(0, 30);
  const tot = (ds, f) => sum(ds, (d) => f(byDay[d]));

  // ---- Выручка, выплаты, прибыль за 30 дней и предыдущие 30 ----
  const revenue = tot(cur, (x) => x.wb + x.ozon);
  const revenuePrev = tot(prev, (x) => x.wb + x.ozon);
  // Выплаты Ozon за период берём из финансов (точнее, чем оценка по дням)
  const payout = tot(cur, (x) => x.wbPay) + (oz ? oz.finance?.payout ?? tot(cur, (x) => x.ozPay) : 0);
  const payoutPrev = tot(prev, (x) => x.wbPay) + (oz ? oz.financePrev?.payout ?? tot(prev, (x) => x.ozPay) : 0);
  const cogs = tot(cur, (x) => x.cogs);
  const cogsPrev = tot(prev, (x) => x.cogs);
  const fixed = Number(S.fixedCostsMonthly) || 0;
  const adSpend = sum(ads, (c) => c.spend);
  // Реклама за прошлый период из API не берём (только 30 дней) — считаем такой же. Это оценка.
  const profit = payout - cogs - fixed - adSpend;
  const profitPrev = payoutPrev - cogsPrev - fixed - adSpend;
  const margin = revenue ? (profit / revenue) * 100 : 0;
  const marginPrev = revenuePrev ? (profitPrev / revenuePrev) * 100 : 0;

  // Мини-графики за 14 дней
  const last14 = days.slice(-14);
  const dayProfit = (d) => byDay[d].wbPay + byDay[d].ozPay - byDay[d].cogs - fixed / 30 - byDay[d].ads;
  const kpi = {
    revenue: { value: round(revenue), prev: round(revenuePrev), delta: pct(revenue, revenuePrev), spark: last14.map((d) => round(byDay[d].wb + byDay[d].ozon)) },
    profit: { value: round(profit), prev: round(profitPrev), delta: pct(profit, profitPrev), spark: last14.map((d) => round(dayProfit(d))) },
    margin: {
      value: +margin.toFixed(1), prev: +marginPrev.toFixed(1), delta: +(margin - marginPrev).toFixed(1), unit: 'pp',
      spark: last14.map((d) => { const r = byDay[d].wb + byDay[d].ozon; return r ? +((dayProfit(d) / r) * 100).toFixed(1) : 0; })
    },
    cash: { value: round(cash), prev: round(balanceAt(isoDay(daysAgo(30)))), delta: pct(cash, balanceAt(isoDay(daysAgo(30)))), spark: last14.map((d) => round(balanceAt(d))) }
  };
  if (!hasMP) demo.push('kpi.revenue', 'kpi.profit', 'kpi.margin');
  else estimated.push('kpi.profit', 'kpi.margin');
  if (!hasBank) demo.push('kpi.cash');

  // ---- План месяца ----
  const today = isoDay();
  const monthStart = today.slice(0, 8) + '01';
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const fact = sum(days.filter((d) => d >= monthStart), (d) => byDay[d].wb + byDay[d].ozon);
  const planValue = Number(S.revenuePlan) || 0;
  const plan = {
    plan: planValue, fact: round(fact), day: dayOfMonth, days: daysInMonth,
    forecast: round((fact / dayOfMonth) * daysInMonth),
    pct: planValue ? +((fact / planValue) * 100).toFixed(1) : 0
  };
  if (!hasMP) demo.push('plan');

  // ---- Маржинальность и ДРР по каналам ----
  const chan = (key, name, rev, pay, cg, adsList) => {
    const spend = sum(adsList, (c) => c.spend);
    const p = pay - cg - spend;
    return { key, name, revenue: round(rev), payout: round(pay), cogs: round(cg), ads: round(spend), profit: round(p), margin: rev ? +((p / rev) * 100).toFixed(1) : 0, drr: rev ? +((spend / rev) * 100).toFixed(1) : 0 };
  };
  const channels = [];
  if (wb) channels.push(chan('wb', 'Wildberries', tot(cur, (x) => x.wb), tot(cur, (x) => x.wbPay), tot(cur, (x) => x.wbCogs), ads.filter((c) => c.mp === 'wb')));
  if (oz) channels.push(chan('ozon', 'Ozon', tot(cur, (x) => x.ozon), oz.finance?.payout ?? tot(cur, (x) => x.ozPay), tot(cur, (x) => x.ozCogs), ads.filter((c) => c.mp === 'ozon')));
  if (!hasMP) demo.push('channels');
  // Сайта нет в API — если продажи сайта не заданы в settings, канал не показываем

  // ---- Прогноз денег на 30 дней ----
  const payments = upcomingPayments(S, 45);
  let cashflow = null;
  if (hasBank) {
    const minCash = Number(S.minCashReserve) || 0;
    const last28 = days.slice(-28);
    // Приток: средние выплаты маркетплейсов в день; без маркетплейсов — средний приход по банку
    const inflowMP = hasMP ? sum(last28, (d) => byDay[d].wbPay + byDay[d].ozPay) / 28 : 0;
    const inflowBank = sum(ops.filter((o) => o.amount > 0 && o.date >= last28[0]), (o) => o.amount) / 28;
    const inflow = hasMP ? inflowMP : inflowBank;
    // Расход в день: постоянные расходы + закупка товара (себестоимость) + реклама
    const outflow = fixed / 30 + (hasMP ? sum(last28, (d) => byDay[d].cogs) / 28 : 0) + adSpend / 30;
    const fdays = [];
    // Факт — последние 14 дней по банку
    for (const d of days.slice(-14)) fdays.push({ date: d, fact: round(balanceAt(d)), forecast: null, lo: null, hi: null });
    fdays[fdays.length - 1].forecast = fdays[fdays.length - 1].fact;
    let bal = cash;
    let gap = null;
    for (let i = 1; i <= 30; i++) {
      const date = isoDay(Date.now() + i * 86400000);
      const pays = payments.filter((p) => p.date === date);
      bal += inflow - outflow - sum(pays, (p) => p.amount);
      // Коридор неопределённости растёт с горизонтом: ±12% от накопленного притока
      const spread = inflow * i * 0.12;
      fdays.push({ date, fact: null, forecast: round(bal), lo: round(bal - spread), hi: round(bal + spread), pays: pays.map((p) => p.name) });
      if (!gap && bal < minCash) gap = { date, amount: round(bal), reason: pays.map((p) => p.name).join(', ') || 'расходы превышают поступления' };
    }
    cashflow = { days: fdays, gap, start: round(cash), end: round(bal), inflow: round(inflow), outflow: round(outflow), minCash };
    estimated.push('cashflow');
  } else demo.push('cashflow');

  // ---- Дебиторка (что маркетплейсы должны перечислить) — оценка ----
  const receivables = { total: 0, items: [] };
  if (wb) {
    // WB перечисляет еженедельно за прошлую неделю: к выплате ≈ выплаты за последние 7 дней
    const v = tot(days.slice(-7), (x) => x.wbPay);
    receivables.items.push({ name: 'Wildberries', amount: round(v), note: 'выплата за текущую неделю' });
  }
  if (oz) {
    // Ozon перечисляет дважды в месяц: ≈ выплаты за последние 14 дней
    const v = tot(days.slice(-14), (x) => x.ozPay);
    receivables.items.push({ name: 'Ozon', amount: round(v), note: 'за текущий расчётный период' });
  }
  receivables.total = sum(receivables.items, (x) => x.amount);
  if (!hasMP) demo.push('receivables'); else estimated.push('receivables');

  // ---- Продажи ----
  const d7 = days.slice(-7);
  const d7prev = days.slice(-14, -7);
  const wbOrders7 = (wb?.orders || []).filter((o) => o.date >= d7[0] && !o.cancel).length;
  const ozUnits7 = sum((oz?.daily || []).filter((r) => r.date >= d7[0]), (r) => r.units);
  const returns7 = (wb?.sales || []).filter((s) => s.isReturn && s.date >= d7[0]).length;
  const sold7 = (wb?.sales || []).filter((s) => !s.isReturn && s.date >= d7[0]).length;
  const sales = {
    today: round(byDay[today]?.wb + byDay[today]?.ozon),
    yesterday: round(byDay[isoDay(daysAgo(1))]?.wb + byDay[isoDay(daysAgo(1))]?.ozon),
    week: round(tot(d7, (x) => x.wb + x.ozon)),
    weekPrev: round(tot(d7prev, (x) => x.wb + x.ozon)),
    orders7: wbOrders7 + round(ozUnits7),
    returns7,
    returnsPct: sold7 ? +((returns7 / sold7) * 100).toFixed(1) : 0,
    daily: cur.map((d) => ({ date: d, wb: round(byDay[d].wb), ozon: round(byDay[d].ozon) }))
  };
  if (!hasMP) demo.push('sales');

  // ---- Склад ----
  const A = buildAnalytics(B);
  const stockItems = A.articles.filter((a) => a.stock != null).map((a) => ({ article: a.article, name: a.name, mp: a.mp, qty: a.stock, inWay: a.inWay, perDay: a.perDay, days: a.days }))
    .sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
  const reorderDays = Number(S.reorderDays) || 14;
  const stock = { items: stockItems, total: sum(stockItems, (x) => x.qty), low: stockItems.filter((x) => x.days != null && x.days < reorderDays).length, reorderDays };
  if (!hasMP) demo.push('stock');

  // ---- Реклама ----
  const adsBlock = {
    spend: round(adSpend),
    ordersSum: round(sum(ads, (c) => c.ordersSum)),
    drr: revenue ? +((adSpend / revenue) * 100).toFixed(1) : 0,
    maxDrr: Number(S.maxDrr) || 15,
    campaigns: A.campaigns
  };
  if (!hasAds) demo.push('ads');

  // ---- Маркетплейсы по отдельности ----
  const mpBlock = (key) => {
    const rev = tot(cur, (x) => x[key]);
    const pay = key === 'wb' ? tot(cur, (x) => x.wbPay) : oz?.finance?.payout ?? 0;
    const spend = sum(ads.filter((c) => c.mp === key), (c) => c.spend);
    const stk = stockItems.filter((s) => s.mp === key);
    return {
      connected: key === 'wb' ? !!wb : !!oz,
      revenue: round(rev), revenuePrev: round(tot(prev, (x) => x[key])), payout: round(pay),
      ads: round(spend), drr: rev ? +((spend / rev) * 100).toFixed(1) : 0,
      stockQty: sum(stk, (s) => s.qty), skus: stk.length,
      returns: key === 'wb' ? (wb?.sales || []).filter((s) => s.isReturn && s.date >= cur[0]).length : null,
      finance: key === 'ozon' ? oz?.finance || null : null
    };
  };
  const marketplaces = { wb: mpBlock('wb'), ozon: mpBlock('ozon') };
  if (!hasMP) demo.push('marketplaces');

  // ---- Финансы: P&L за 30 дней и банк ----
  const finance = {
    revenue: round(revenue),
    mpCosts: round(revenue - payout), // комиссии, логистика, хранение, возвраты — всё, что удержали маркетплейсы
    ozon: oz?.finance || null,
    payout: round(payout), cogs: round(cogs), fixed: round(fixed), ads: round(adSpend), profit: round(profit),
    margin: +margin.toFixed(1)
  };
  if (!hasMP) demo.push('finance'); else estimated.push('finance');
  const bank = { accounts, ops: ops.slice(0, 100), total: round(cash) };
  if (!hasBank) demo.push('bank');

  // ---- Блоки без источника в API — всегда демо ----
  demo.push('supplies', 'traffic');

  const crm = crmData();
  if (crm.provider === 'local' && !crm.deals.length) demo.push('crm');

  return {
    company: S.companyName || 'BrandOS',
    owner: S.ownerName || 'Владелец',
    team: S.team || [],
    sources: { wb: !!wb, ozon: !!oz, bank: hasBank, crm: crm.provider !== 'local' },
    lastSync: db.lastSync,
    syncing: !!db.syncing,
    demo, estimated,
    kpi, plan, cashflow, channels, payments, receivables, sales, stock, ads: adsBlock, marketplaces, finance, bank,
    settings: { maxDrr: Number(S.maxDrr) || 15, reorderDays, revenuePlan: planValue, cogsPercent: Number(S.cogsPercent) || 0, fixedCostsMonthly: fixed, decisionHour: S.decisionHour ?? 8, syncMinutes: S.syncMinutes ?? 30, taxRate: S.taxRate ?? 6 }
  };
}

// ====== Таблицы артикулов и кампаний (страница «Аналитика» и вход для Центра решений) ======
export function buildAnalytics(B = base()) {
  const { wb, oz, ads, cogsOf, ozPayoutRatio, skuToArticle, S } = B;
  const from28 = isoDay(daysAgo(27));
  const from7 = isoDay(daysAgo(6));
  const from14 = isoDay(daysAgo(13));
  const map = new Map();
  const get = (mp, article, name) => {
    const key = `${mp}:${article}`;
    if (!map.has(key)) map.set(key, { mp, article, name: name || article, revenue: 0, payout: 0, units: 0, rev7: 0, revPrev7: 0, cogs: 0, stock: null, inWay: 0, adSpend: 0, nmId: null });
    return map.get(key);
  };

  for (const s of wb?.sales || []) {
    if (s.date < from28) continue;
    const a = get('wb', s.article, s.name);
    a.nmId = s.nmId;
    a.revenue += s.revenue; a.payout += s.payout; a.units += s.units;
    a.cogs += cogsOf(s.article, s.revenue, s.units);
    if (s.date >= from7) a.rev7 += s.revenue;
    else if (s.date >= from14) a.revPrev7 += s.revenue;
  }
  for (const s of wb?.stocks || []) { const a = get('wb', s.article, s.name); a.stock = s.qty; a.inWay = s.inWay; a.nmId ??= s.nmId; }

  // Ozon: по SKU есть только итог 28 дней — тренд недели по артикулу недоступен (null)
  for (const r of oz?.bySku || []) {
    const article = skuToArticle.get(r.sku) || r.sku;
    const a = get('ozon', article, r.name);
    a.revenue += r.revenue; a.units += r.units; a.payout += r.revenue * ozPayoutRatio;
    a.cogs += cogsOf(article, r.revenue, r.units);
    a.noTrend = true;
  }
  for (const s of oz?.stocks || []) { const a = get('ozon', s.article, s.name); a.stock = s.qty; a.inWay = s.inWay; }

  // Реклама WB привязана к nmId — делим расход кампании поровну между её артикулами
  const byNm = new Map([...map.values()].filter((a) => a.nmId).map((a) => [String(a.nmId), a]));
  for (const c of ads) {
    const linked = (c.articles || []).map((nm) => byNm.get(String(nm))).filter(Boolean);
    for (const a of linked) a.adSpend += c.spend / linked.length;
  }

  const articles = [...map.values()].map((a) => {
    const perDay = a.units > 0 ? a.units / 28 : 0;
    const profit = a.payout - a.cogs - a.adSpend;
    return {
      mp: a.mp, article: a.article, name: a.name,
      revenue: round(a.revenue),
      trend7: a.noTrend ? null : a.revPrev7 ? +(((a.rev7 - a.revPrev7) / a.revPrev7) * 100).toFixed(1) : null,
      sold: a.units, stock: a.stock, inWay: a.inWay,
      perDay: +perDay.toFixed(2),
      days: a.stock != null && perDay > 0 ? Math.floor(a.stock / perDay) : null,
      adSpend: round(a.adSpend),
      drr: a.revenue ? +((a.adSpend / a.revenue) * 100).toFixed(1) : 0,
      profit: round(profit),
      margin: a.revenue ? +((profit / a.revenue) * 100).toFixed(1) : 0
    };
  }).sort((x, y) => y.revenue - x.revenue);

  // Кампании: месяц и неделя, CTR, цена заказа
  const campaigns = ads.map((c) => {
    const week = (c.daily || []).filter((d) => d.date >= from7);
    const spend7 = sum(week, (d) => d.spend);
    const ordersSum7 = sum(week, (d) => d.ordersSum);
    return {
      mp: c.mp, id: c.id, name: c.name, status: c.status,
      spend: round(c.spend), orders: c.orders, ordersSum: round(c.ordersSum),
      drr: c.ordersSum ? +((c.spend / c.ordersSum) * 100).toFixed(1) : null,
      spend7: round(spend7), orders7: sum(week, (d) => d.orders),
      drr7: ordersSum7 ? +((spend7 / ordersSum7) * 100).toFixed(1) : null,
      ctr: c.views ? +((c.clicks / c.views) * 100).toFixed(2) : 0,
      cpo: c.orders ? round(c.spend / c.orders) : null
    };
  }).sort((a, b) => b.spend - a.spend);

  return { articles, campaigns, maxDrr: Number(S.maxDrr) || 15, live: { mp: !!(wb || oz), ads: ads.length > 0 } };
}

// Компактная сводка для ИИ (чат и Центр решений) — без ключей и лишнего
export function snapshotForAI() {
  const D = buildDashboard();
  const A = buildAnalytics();
  const crm = crmData();
  const stageName = Object.fromEntries(crm.stages.map((s) => [s.id, s.name]));
  return {
    today: isoDay(),
    company: D.company,
    demo: D.demo,
    estimated: D.estimated,
    settings: D.settings,
    kpi30d: { revenue: D.kpi.revenue, profit: D.kpi.profit, margin: D.kpi.margin, cash: D.kpi.cash },
    plan: D.plan,
    channels: D.channels,
    cashflow: D.cashflow && { start: D.cashflow.start, end30: D.cashflow.end, inflowPerDay: D.cashflow.inflow, outflowPerDay: D.cashflow.outflow, gap: D.cashflow.gap },
    payments: D.payments.slice(0, 10),
    receivables: D.receivables,
    sales: { ...D.sales, daily: undefined },
    articles: A.articles.slice(0, 60),
    campaigns: A.campaigns.slice(0, 40),
    crm: {
      provider: crm.provider,
      byStage: crm.stages.map((s) => ({ stage: s.name, count: crm.deals.filter((d) => d.st === s.id).length, sum: sum(crm.deals.filter((d) => d.st === s.id), (d) => d.sum) })),
      openDeals: crm.deals.filter((d) => !d.closed).slice(0, 30).map((d) => ({ name: d.c, sum: d.sum, stage: stageName[d.st] || d.st, manager: d.mgr, created: d.d }))
    },
    documents: db.documents.slice(0, 30).map((d) => ({ name: d.name, source: d.source, status: d.status, type: d.ai?.type, counterparty: d.ai?.counterparty, amount: d.ai?.amount, due: d.ai?.due, needPay: d.ai?.needPay, needSign: d.ai?.needSign })),
    tasks: db.tasks.filter((t) => t.status !== 'done').slice(0, 40).map((t) => ({ title: t.title, status: t.status, priority: t.priority, due: t.due, assignee: t.assignee })),
    pastDecisions: db.decisionLog.slice(-30)
  };
}
