// Управленческие отчёты BrandOS.
//  • ОПиУ (P&L по месяцам)  — «куда ушла выручка»: выручка → удержания → себестоимость → реклама → расходы → налог → прибыль.
//  • P&L по каналам         — тот же расчёт, но столбцы — маркетплейсы: какой канал реально зарабатывает.
//  • ДДС                     — «куда ушли деньги со счёта»: операции банка, разложенные по статьям.
//  • РНП («рука на пульсе») — ежедневные заказы, продажи, реклама и прибыль по каналам.
//  • Налоги                  — доходы и взносы по кварталам для шаблонов декларации УСН и уведомлений.
// Аналогия: ОПиУ — это «заработали ли мы», ДДС — «хватит ли денег». Прибыль может быть,
// а денег нет (товар закуплен впрок) — поэтому нужны оба отчёта.
import { isoDay } from './db.js';

const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const round = (n) => Math.round(Number(n) || 0);
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

// Выручка и выплаты дня по всем маркетплейсам — единая формула для всех разделов
export const rev = (b) => b.wb + b.ozon + b.ym;
export const pay = (b) => b.wbPay + b.ozPay + b.ymPay;

// Каналы: ключ, название, поля выручки / выплат / себестоимости в ряду byDay
export const CHANNELS = [
  { key: 'wb', name: 'Wildberries', r: 'wb', p: 'wbPay', c: 'wbCogs' },
  { key: 'ozon', name: 'Ozon', r: 'ozon', p: 'ozPay', c: 'ozCogs' },
  { key: 'ym', name: 'Яндекс Маркет', r: 'ym', p: 'ymPay', c: 'ymCogs' }
];

// Налог УСН: «доходы» — % от выручки; «доходы минус расходы» — % от разницы, но не меньше 1% от доходов
export function taxOf(S, income, expenses) {
  const obj = S.taxpayer?.taxObject || 'income';
  const rate = Number(S.taxRate) || (obj === 'income' ? 6 : 15);
  if (obj === 'income') return (income * rate) / 100;
  return Math.max(((income - expenses) * rate) / 100, income * 0.01);
}

// Строка отчёта. type: head — крупная строка, item — обычная, detail — расшифровка (с отступом),
// sub — промежуточный итог, total — главный итог, pct — проценты, section — заголовок раздела без чисел
const row = (key, label, type, values) => ({ key, label, type, values: values.map((v) => (v == null ? null : type === 'pct' ? +Number(v).toFixed(1) : round(v))) });

// Месяцы, попавшие в окно данных (неполные месяцы помечаем: «с 12.08» / «по 10.10»)
function monthsIn(days) {
  const map = new Map();
  for (const d of days) {
    const k = d.slice(0, 7);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  const today = isoDay();
  return [...map.entries()].map(([key, ds]) => {
    const [y, m] = key.split('-').map(Number);
    const inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const startsLate = Number(ds[0].slice(8, 10)) > 1;
    const isCurrent = key === today.slice(0, 7);
    return {
      key, days: ds, inMonth,
      label: `${MONTHS[m - 1]} ${y}`,
      note: startsLate ? `с ${dm(ds[0])}` : isCurrent ? `по ${dm(ds.at(-1))}` : ''
    };
  });
}

// ====== ОПиУ по месяцам ======
function opiu(B) {
  const { S, byDay, days, ads } = B;
  const fixedMonthly = Number(S.fixedCostsMonthly) || 0;
  const breakdown = Array.isArray(S.fixedCostsBreakdown) ? S.fixedCostsBreakdown : [];
  const active = CHANNELS.filter((c) => B[c.key === 'ozon' ? 'oz' : c.key]);
  const months = monthsIn(days);

  // Реклама по дням — из ежедневной статистики кампаний
  const adsByDay = {};
  for (const c of ads) for (const x of c.daily || []) adsByDay[x.date] = (adsByDay[x.date] || 0) + x.spend;

  const col = (ds, fixed) => {
    const t = (f) => sum(ds, (d) => f(byDay[d]));
    const revenue = t(rev);
    const payout = t(pay);
    const cogs = t((b) => b.cogs);
    const adSpend = sum(ds, (d) => adsByDay[d] || 0);
    const ebt = payout - cogs - adSpend - fixed;
    const expenses = revenue - payout + cogs + adSpend + fixed;
    const tax = taxOf(S, revenue, expenses);
    return {
      revenue, payout, cogs, ads: adSpend, fixed, ebt, tax,
      byCh: Object.fromEntries(active.map((c) => [c.key, t((b) => b[c.r])])),
      gross: payout - cogs,
      net: ebt - tax
    };
  };
  const cols = months.map((m) => col(m.days, (fixedMonthly * m.days.length) / m.inMonth));
  const total = col(days, sum(cols, (c) => c.fixed));
  const all = [...cols, total];
  const v = (f) => all.map(f);
  const pctOf = (a, b) => (b ? (a / b) * 100 : 0);

  const fixedRows = breakdown.length
    ? breakdown.map((x, i) => row(`fixed${i}`, x.name, 'detail', v((c) => (-c.fixed * (Number(x.amount) || 0)) / (sum(breakdown, (y) => y.amount) || 1))))
    : [];

  const rows = [
    row('revenue', 'Выручка', 'head', v((c) => c.revenue)),
    ...active.map((ch) => row(`rev_${ch.key}`, ch.name, 'detail', v((c) => c.byCh[ch.key]))),
    row('mp', 'Комиссии, логистика и услуги маркетплейсов', 'item', v((c) => -(c.revenue - c.payout))),
    row('payout', 'Выплаты маркетплейсов', 'sub', v((c) => c.payout)),
    row('cogs', 'Себестоимость проданного товара', 'item', v((c) => -c.cogs)),
    row('gross', 'Валовая прибыль', 'sub', v((c) => c.gross)),
    row('ads', 'Реклама на маркетплейсах', 'item', v((c) => -c.ads)),
    row('fixed', 'Постоянные расходы', 'item', v((c) => -c.fixed)),
    ...fixedRows,
    row('ebt', 'Прибыль до налога (как на главной)', 'sub', v((c) => c.ebt)),
    row('tax', `Налог УСН (${S.taxpayer?.taxObject === 'income-expense' ? 'доходы минус расходы' : 'доходы'}, ${Number(S.taxRate) || 6}%)`, 'item', v((c) => -c.tax)),
    row('net', 'Чистая прибыль', 'total', v((c) => c.net)),
    row('margin', 'Рентабельность по чистой прибыли', 'pct', v((c) => pctOf(c.net, c.revenue))),
    row('grossMargin', 'Валовая маржа', 'pct', v((c) => pctOf(c.gross, c.revenue)))
  ];
  return {
    columns: [...months.map((m) => ({ key: m.key, label: m.label, note: m.note })), { key: 'total', label: 'Итого', note: `${days.length} дн.` }],
    rows,
    note: 'Выручка — по продажам маркетплейсов, выплаты Ozon по дням оценены по доле из финансового отчёта. Постоянные расходы распределены по дням месяца, налог — без уменьшения на взносы.'
  };
}

// ====== P&L по каналам за 30 дней ======
function pnlByChannel(B) {
  const { S, byDay, days, ads, oz } = B;
  const cur = days.slice(-30);
  const fixed = Number(S.fixedCostsMonthly) || 0;
  const active = CHANNELS.filter((c) => B[c.key === 'ozon' ? 'oz' : c.key]);
  const t = (f) => sum(cur, (d) => f(byDay[d]));
  const totalRev = t(rev) || 1;

  const col = (ch) => {
    const revenue = t((b) => b[ch.r]);
    // Выплаты Ozon за 30 дней берём из финансового отчёта — так же, как на главной
    const payout = ch.key === 'ozon' && oz?.finance?.payout != null ? oz.finance.payout : t((b) => b[ch.p]);
    const cogs = t((b) => b[ch.c]);
    const adSpend = sum(ads.filter((c) => c.mp === ch.key), (c) => c.spend);
    const contribution = payout - cogs - adSpend;
    const fixedShare = (fixed * revenue) / totalRev;
    const ebt = contribution - fixedShare;
    const tax = taxOf(S, revenue, revenue - payout + cogs + adSpend + fixedShare);
    return { revenue, payout, cogs, ads: adSpend, contribution, fixed: fixedShare, ebt, tax, net: ebt - tax };
  };
  const cols = active.map(col);
  const keys = ['revenue', 'payout', 'cogs', 'ads', 'contribution', 'fixed', 'ebt', 'tax', 'net'];
  const total = Object.fromEntries(keys.map((k) => [k, sum(cols, (c) => c[k])]));
  // Если каналов нет — постоянные расходы всё равно есть
  if (!cols.length) Object.assign(total, { fixed, ebt: -fixed, net: -fixed });
  const all = [...cols, total];
  const v = (f) => all.map(f);
  const pctOf = (a, b) => (b ? (a / b) * 100 : 0);
  return {
    columns: [...active.map((c) => ({ key: c.key, label: c.name })), { key: 'total', label: 'Итого', note: '30 дней' }],
    rows: [
      row('revenue', 'Выручка', 'head', v((c) => c.revenue)),
      row('share', 'Доля в выручке', 'pct', v((c) => pctOf(c.revenue, total.revenue))),
      row('mp', 'Удержания маркетплейса', 'item', v((c) => -(c.revenue - c.payout))),
      row('payout', 'Выплаты', 'sub', v((c) => c.payout)),
      row('cogs', 'Себестоимость', 'item', v((c) => -c.cogs)),
      row('ads', 'Реклама', 'item', v((c) => -c.ads)),
      row('drr', 'ДРР (реклама к выручке)', 'pct', v((c) => pctOf(c.ads, c.revenue))),
      row('contribution', 'Маржинальный доход канала', 'sub', v((c) => c.contribution)),
      row('fixed', 'Постоянные расходы (по доле выручки)', 'item', v((c) => -c.fixed)),
      row('ebt', 'Прибыль до налога', 'sub', v((c) => c.ebt)),
      row('tax', 'Налог УСН', 'item', v((c) => -c.tax)),
      row('net', 'Чистая прибыль', 'total', v((c) => c.net)),
      row('margin', 'Рентабельность', 'pct', v((c) => pctOf(c.net, c.revenue)))
    ],
    note: 'Маржинальный доход — сколько канал оставляет после своих прямых расходов (удержания, себестоимость, реклама). Постоянные расходы делятся между каналами пропорционально выручке.'
  };
}

// ====== ДДС: статьи движения денег ======
// Правила разбора операций банка: [статья, направление, регулярное выражение по контрагенту и назначению].
// Порядок важен: первое совпадение побеждает (налоги раньше поставщиков — в назначении налога тоже бывает «счёт»).
export const DDS_ITEMS = [
  { key: 'mp_in', label: 'Выплаты маркетплейсов', sec: 'op', dir: 'in', re: /вайлдберриз|wildberries|(^|\s)wb(\s|$)|интернет решения|озон|ozon|яндекс|маркет/i },
  { key: 'loan_in', label: 'Кредиты и займы получены', sec: 'fin', dir: 'in', re: /кредит|займ/i },
  { key: 'owner_in', label: 'Взносы собственника', sec: 'fin', dir: 'in', re: /учредител|собственн|владельц/i },
  { key: 'cust_in', label: 'Оплаты от покупателей', sec: 'op', dir: 'in', re: /оплат|сч[её]т|договор|поставк/i },
  { key: 'other_in', label: 'Прочие поступления', sec: 'op', dir: 'in', re: /./ },
  { key: 'tax', label: 'Налоги и взносы', sec: 'op', dir: 'out', re: /налог|ндфл|взнос|усн|енп|фнс|ифнс|казначейств/i },
  { key: 'salary', label: 'Зарплата', sec: 'op', dir: 'out', re: /зарплат|заработн|аванс по з|отпускн|преми/i },
  { key: 'rent', label: 'Аренда', sec: 'op', dir: 'out', re: /аренд/i },
  { key: 'ads', label: 'Реклама и продвижение', sec: 'op', dir: 'out', re: /реклам|продвижен|директ|маркетинг/i },
  { key: 'bank', label: 'Банковские комиссии', sec: 'op', dir: 'out', re: /комисси[яи]\s+(банк|за)|обслуживани[ея] сч|ведение сч|тариф/i },
  { key: 'owner_out', label: 'Выплаты собственнику', sec: 'fin', dir: 'out', re: /дивиденд|вывод средств|собственн|личные нужды|владельц/i },
  { key: 'loan_out', label: 'Погашение кредитов и процентов', sec: 'fin', dir: 'out', re: /погашени|кредит|займ|процент/i },
  { key: 'capex', label: 'Оборудование и основные средства', sec: 'inv', dir: 'out', re: /оборудован|станок|основн\w* средств/i },
  { key: 'logistics', label: 'Доставка и логистика', sec: 'op', dir: 'out', re: /доставк|логист|сдэк|cdek|деловые линии|транспорт|грузоперевоз/i },
  { key: 'supplier', label: 'Поставщики: товар и материалы', sec: 'op', dir: 'out', re: /поставк|товар|материал|сыр[ьё]|ткан|фанер|брус|картон|упаков|сч[её]т|упд|закуп/i },
  { key: 'other_out', label: 'Прочие платежи', sec: 'op', dir: 'out', re: /./ }
];
export function categorize(op) {
  const dir = op.amount >= 0 ? 'in' : 'out';
  const text = `${op.party || ''} ${op.purpose || ''}`;
  return DDS_ITEMS.find((it) => it.dir === dir && it.re.test(text))?.key || (dir === 'in' ? 'other_in' : 'other_out');
}

function dds(B) {
  const { ops, balanceAt, days } = B;
  const months = monthsIn(days);
  const dayBefore = (iso) => isoDay(new Date(new Date(`${iso}T00:00:00Z`).getTime() - 86400000));
  const tagged = ops.filter((o) => o.date >= days[0]).map((o) => ({ ...o, cat: categorize(o) }));

  const col = (from, to) => {
    const list = tagged.filter((o) => o.date >= from && o.date <= to);
    const by = Object.fromEntries(DDS_ITEMS.map((it) => [it.key, sum(list.filter((o) => o.cat === it.key), (o) => o.amount)]));
    const sec = (s) => sum(DDS_ITEMS.filter((it) => it.sec === s), (it) => by[it.key]);
    return {
      open: balanceAt(dayBefore(from)), close: balanceAt(to), by,
      opIn: sum(DDS_ITEMS.filter((it) => it.sec === 'op' && it.dir === 'in'), (it) => by[it.key]),
      opOut: sum(DDS_ITEMS.filter((it) => it.sec === 'op' && it.dir === 'out'), (it) => by[it.key]),
      op: sec('op'), inv: sec('inv'), fin: sec('fin'),
      net: sum(list, (o) => o.amount)
    };
  };
  const cols = [...months.map((m) => col(m.days[0], m.days.at(-1))), col(days[0], days.at(-1))];
  const v = (f) => cols.map(f);
  // Строки статей показываем, только если по статье были движения — иначе отчёт «шумит» нулями
  const items = (sec, dir) => DDS_ITEMS.filter((it) => it.sec === sec && (!dir || it.dir === dir) && cols.some((c) => c.by[it.key]))
    .map((it) => row(it.key, it.label, 'detail', v((c) => c.by[it.key])));
  const rows = [
    row('open', 'Остаток на начало периода', 'head', v((c) => c.open)),
    row('s_op', 'Операционная деятельность', 'section', v(() => null)),
    row('opIn', 'Поступления', 'item', v((c) => c.opIn)),
    ...items('op', 'in'),
    row('opOut', 'Платежи', 'item', v((c) => c.opOut)),
    ...items('op', 'out'),
    row('op', 'Сальдо операционной деятельности', 'sub', v((c) => c.op)),
    row('s_inv', 'Инвестиционная деятельность', 'section', v(() => null)),
    ...items('inv'),
    row('inv', 'Сальдо инвестиционной деятельности', 'sub', v((c) => c.inv)),
    row('s_fin', 'Финансовая деятельность', 'section', v(() => null)),
    ...items('fin'),
    row('fin', 'Сальдо финансовой деятельности', 'sub', v((c) => c.fin)),
    row('net', 'Чистый денежный поток', 'total', v((c) => c.net)),
    row('close', 'Остаток на конец периода', 'head', v((c) => c.close))
  ];
  const unknown = tagged.filter((o) => o.cat === 'other_in' || o.cat === 'other_out').length;
  return {
    columns: [...months.map((m) => ({ key: m.key, label: m.label, note: m.note })), { key: 'total', label: 'Итого', note: `${days.length} дн.` }],
    rows,
    unknown,
    note: `Статьи определяются по контрагенту и назначению платежа.${unknown ? ` Не распознано операций: ${unknown} — они в «Прочих».` : ''}`
  };
}

export function buildReports(B) {
  return { opiu: opiu(B), pnl: pnlByChannel(B), dds: dds(B) };
}

// ====== РНП — «рука на пульсе»: показатели каждого дня по каждому каналу ======
export function buildRnp(B) {
  const { S, wb, oz, ym, ads, byDay, days } = B;
  const last = days.slice(-30);
  const blank = () => ({ orders: 0, ordersSum: 0, sales: 0, payout: 0, cogs: 0, ads: 0, returns: 0 });
  const rows = Object.fromEntries(last.map((d) => [d, { wb: blank(), ozon: blank(), ym: blank() }]));
  // Заказы: WB — строки заказов, Ozon — заказанные штуки из аналитики, Маркет — штуки в заказах
  for (const o of wb?.orders || []) { const r = rows[o.date]; if (r && !o.cancel) { r.wb.orders += 1; r.wb.ordersSum += o.sum; } }
  for (const s of wb?.sales || []) if (s.isReturn && rows[s.date]) rows[s.date].wb.returns += 1;
  for (const x of oz?.daily || []) { const r = rows[x.date]; if (r) { r.ozon.orders += x.units; r.ozon.ordersSum += x.revenue; } }
  for (const o of ym?.orders || []) {
    const r = rows[o.date];
    if (!r || o.cancelled) continue;
    r.ym.orders += o.units; r.ym.ordersSum += o.revenue;
    if (o.isReturn) r.ym.returns += 1;
  }
  for (const d of last) {
    const b = byDay[d];
    for (const ch of CHANNELS) Object.assign(rows[d][ch.key], { sales: b[ch.r], payout: b[ch.p], cogs: b[ch.c] });
  }
  for (const c of ads) for (const x of c.daily || []) { const r = rows[x.date]; if (r?.[c.mp]) r[c.mp].ads += x.spend; }

  const today = isoDay();
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const roundObj = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, round(x)]));
  return {
    days: last.map((d) => ({ date: d, wb: roundObj(rows[d].wb), ozon: roundObj(rows[d].ozon), ym: roundObj(rows[d].ym) })),
    channels: [wb && 'wb', oz && 'ozon', ym && 'ym'].filter(Boolean),
    planPerDay: round((Number(S.revenuePlan) || 0) / daysInMonth),
    maxDrr: Number(S.maxDrr) || 15,
    fixedPerDay: round((Number(S.fixedCostsMonthly) || 0) / 30)
  };
}

// ====== Налоги: данные для шаблонов декларации УСН, уведомлений и КУДиР ======
export function buildTax(B) {
  const { S, byDay, days, ops } = B;
  const year = Number(isoDay().slice(0, 4));
  const tp = S.taxpayer || {};
  const obj = tp.taxObject === 'income-expense' ? 'income-expense' : 'income';
  const rate = Number(S.taxRate) || (obj === 'income' ? 6 : 15);
  const fixedPerDay = (Number(S.fixedCostsMonthly) || 0) / 30;
  const hist = S.taxHistory?.[year] || S.taxHistory?.[String(year)] || {};
  const qOf = (iso) => Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1;
  // Сколько дней квартала уже прошло (у будущих кварталов — 0, у текущего — до сегодня)
  const todayMs = Date.parse(`${isoDay()}T00:00:00Z`);
  const quarterDays = (q) => {
    const s = Date.UTC(year, (q - 1) * 3, 1);
    const e = Math.min(Date.UTC(year, q * 3, 1), todayMs + 86400000);
    return Math.max(0, Math.round((e - s) / 86400000));
  };

  const q = [1, 2, 3, 4].map((n) => ({ q: n, income: 0, expense: 0, contributions: 0, mpAdjust: 0, days: 0, totalDays: quarterDays(n), source: 'none' }));
  // Доход по УСН у продавца маркетплейса — полная цена продажи (комиссия маркетплейса — расход, а не уменьшение дохода)
  for (const d of days) {
    if (Number(d.slice(0, 4)) !== year) continue;
    const b = byDay[d];
    const x = q[qOf(d) - 1];
    x.income += rev(b);
    x.mpAdjust += rev(b) - pay(b);
    x.expense += rev(b) - pay(b) + b.cogs + b.ads + fixedPerDay;
    x.days += 1;
  }
  // Прочие доходы — оплаты покупателей на расчётный счёт; взносы — по платежам с «взнос» в назначении
  const yearOps = ops.filter((o) => Number(o.date.slice(0, 4)) === year).map((o) => ({ ...o, cat: categorize(o) }));
  for (const o of yearOps) {
    const x = q[qOf(o.date) - 1];
    if (o.cat === 'cust_in' || o.cat === 'other_in') x.income += o.amount;
    if (o.cat === 'tax' && /взнос/i.test(`${o.purpose} ${o.party}`)) x.contributions += -o.amount;
  }
  for (const x of q) {
    if (x.days) x.source = x.days >= x.totalDays - 1 ? 'data' : 'partial';
    x.future = x.totalDays === 0;
    // Ручные данные из settings.json (taxHistory) важнее: у сервера есть только последние 60 дней
    const h = hist[`q${x.q}`];
    if (h) { Object.assign(x, { income: Number(h.income) || 0, expense: Number(h.expense) || 0, contributions: Number(h.contributions) || 0 }); x.source = 'settings'; }
    for (const k of ['income', 'expense', 'contributions', 'mpAdjust']) x[k] = round(x[k]);
  }
  const incomeOps = yearOps.filter((o) => o.amount > 0 && ['mp_in', 'cust_in', 'other_in'].includes(o.cat))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-300)
    .map((o) => ({ date: o.date, party: o.party, purpose: o.purpose, amount: round(o.amount), mp: o.cat === 'mp_in' }));
  return {
    year, rate, taxObject: obj,
    taxpayer: { kind: tp.kind || 'ИП', name: tp.name || S.companyName || '', inn: tp.inn || '', kpp: tp.kpp || '', oktmo: tp.oktmo || '', ifns: tp.ifns || '', phone: tp.phone || '', hasEmployees: tp.hasEmployees !== false },
    quarters: q,
    incomeOps,
    coverageFrom: days[0]
  };
}
