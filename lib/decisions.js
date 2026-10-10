// Центр решений: раз в день (час — settings.decisionHour) и по кнопке
// собираем полную картину и выдаём список решений на сегодня.
// С ключом Claude — решения пишет ИИ по строгой схеме; без ключа — встроенные правила.
import { db, save, uid, getSettings, isoDay } from './db.js';
import { buildDashboard, buildAnalytics, snapshotForAI } from './aggregate.js';
import { aiEnabled, structured } from './ai.js';

const AREAS = ['реклама', 'склад', 'цены', 'финансы', 'продажи', 'CRM', 'документы'];
const URGENCY = ['критично', 'сегодня', 'на неделе'];
const rub = (n) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const inDays = (n) => isoDay(Date.now() + n * 86400000);
const MP_NAME = { wb: 'WB', ozon: 'Ozon', ym: 'Яндекс Маркет' };

// Строгая JSON-схема одного решения
const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Стабильный ключ: направление:объект, например ads:WB-12345 или stock:ART-01' },
          area: { type: 'string', enum: AREAS },
          urgency: { type: 'string', enum: URGENCY },
          title: { type: 'string', description: 'Заголовок-действие: «Остановить кампанию X», «Дозаказать арт. Y 800 шт»' },
          situation: { type: 'string', description: 'Ситуация с конкретными цифрами из данных' },
          action: { type: 'string', description: 'Что сделать' },
          why: { type: 'string', description: 'Почему это выгодно' },
          steps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
          effect: { type: 'number', description: 'Эффект в рублях в месяц (положительное число)' },
          due: { type: 'string', description: 'Срок YYYY-MM-DD' },
          confidence: { type: 'integer', minimum: 0, maximum: 100, description: 'Уверенность в процентах' },
          metric: { type: 'string', description: 'Какую метрику проверить, чтобы понять, что решение сработало' }
        },
        required: ['key', 'area', 'urgency', 'title', 'situation', 'action', 'why', 'steps', 'effect', 'due', 'confidence', 'metric']
      }
    }
  },
  required: ['decisions']
};

// ===== Встроенные правила (работают без ИИ) =====
export function ruleDecisions() {
  const D = buildDashboard();
  const A = buildAnalytics();
  const S = getSettings();
  const out = [];
  const reorderDays = Number(S.reorderDays) || 14;
  const maxDrr = Number(S.maxDrr) || 15;

  // 1) Дозаказ: остатка хватит меньше чем на reorderDays дней
  for (const a of A.articles) {
    if (a.days == null || a.days >= reorderDays || a.perDay <= 0) continue;
    const need = Math.max(10, Math.ceil((a.perDay * 45 - a.stock - (a.inWay || 0)) / 10) * 10);
    const unitProfit = a.sold > 0 ? Math.max(a.profit / a.sold, (a.revenue / a.sold) * 0.15) : 0;
    const lostDays = Math.max(0, 30 - a.days - 7); // 7 дней — типичная поставка
    out.push({
      key: `stock:${a.mp}:${a.article}`, area: 'склад',
      urgency: a.days < 5 ? 'критично' : a.days < 10 ? 'сегодня' : 'на неделе',
      title: `Дозаказать арт. ${a.article} — ${need} шт`,
      situation: `${MP_NAME[a.mp] || a.mp}: остаток ${a.stock} шт, продаётся ${a.perDay} шт/день — хватит на ${a.days} дн. Порог — ${reorderDays} дн.`,
      action: `Заказать ${need} шт, чтобы закрыть ~45 дней продаж.`,
      why: 'Если товар закончится, карточка теряет позиции в поиске, а продажи — прибыль.',
      steps: [`Согласовать с поставщиком ${need} шт арт. ${a.article}`, 'Оплатить закупку', `Создать поставку на склад ${MP_NAME[a.mp] || a.mp}`],
      effect: Math.round(unitProfit * a.perDay * lostDays), due: inDays(a.days < 5 ? 0 : 2), confidence: 80,
      metric: `Остаток арт. ${a.article} в днях ≥ ${reorderDays}`
    });
  }

  // 2) Рекламные кампании с ДРР выше порога
  for (const c of A.campaigns) {
    if (c.spend < 1000) continue;
    const noOrders = !c.orders;
    if (!noOrders && (c.drr == null || c.drr <= maxDrr)) continue;
    const stop = noOrders || c.drr > maxDrr * 2;
    const excess = noOrders ? c.spend : c.spend - (c.ordersSum * maxDrr) / 100;
    out.push({
      key: `ads:${c.mp}:${c.id}`, area: 'реклама', urgency: stop ? 'сегодня' : 'на неделе',
      title: stop ? `Остановить кампанию «${c.name}»` : `Снизить ставки в кампании «${c.name}»`,
      situation: noOrders
        ? `Потрачено ${rub(c.spend)} за 30 дней, заказов нет.`
        : `ДРР ${c.drr}% при пороге ${maxDrr}%: расход ${rub(c.spend)}, заказы на ${rub(c.ordersSum)}. За неделю ДРР ${c.drr7 ?? '—'}%.`,
      action: stop ? 'Поставить кампанию на паузу и перераспределить бюджет.' : `Снизить ставки на 20–30%, чтобы ДРР вернулась к ${maxDrr}%.`,
      why: `Лишний расход сверх порога ДРР — около ${rub(excess)} в месяц.`,
      steps: stop
        ? [`Поставить на паузу «${c.name}» в кабинете ${c.mp === 'wb' ? 'WB' : 'Ozon Performance'}`, 'Проверить карточку товара: цена, фото, отзывы', 'Через 7 дней сравнить заказы без рекламы']
        : ['Снизить ставку на 20–30%', 'Отключить неэффективные ключевые фразы', 'Через 7 дней проверить ДРР'],
      effect: Math.round(Math.max(0, excess)), due: inDays(1), confidence: noOrders ? 85 : 70,
      metric: `ДРР кампании «${c.name}» ≤ ${maxDrr}%`
    });
  }

  // 3) Артикулы, которые продаются в минус
  for (const a of A.articles) {
    if (a.revenue <= 0 || a.profit >= 0) continue;
    out.push({
      key: `price:${a.mp}:${a.article}`, area: 'цены', urgency: a.profit < -20000 ? 'сегодня' : 'на неделе',
      title: `Вывести арт. ${a.article} из минуса`,
      situation: `За 28 дней выручка ${rub(a.revenue)}, прибыль ${rub(a.profit)} (маржа ${a.margin}%). Реклама на артикул: ${rub(a.adSpend)}.`,
      action: a.drr > maxDrr ? 'Сократить рекламу на артикул и поднять цену на 5–10%.' : 'Поднять цену на 5–10% или пересмотреть себестоимость.',
      why: 'Каждая продажа этого артикула сейчас уменьшает прибыль.',
      steps: ['Проверить себестоимость и комиссию по артикулу', 'Поднять цену на 5–10%', a.adSpend > 0 ? 'Снизить ставки рекламы на артикул' : 'Проверить цены конкурентов', 'Через 14 дней сравнить маржу'],
      effect: Math.round((-a.profit / 28) * 30), due: inDays(3), confidence: 65,
      metric: `Маржа арт. ${a.article} > 0%`
    });
  }

  // 4) Кассовый разрыв в прогнозе
  if (D.cashflow?.gap) {
    const g = D.cashflow.gap;
    out.push({
      key: 'cash:gap', area: 'финансы', urgency: 'критично',
      title: `Закрыть кассовый разрыв ${g.date.split('-').reverse().join('.')}`,
      situation: `По прогнозу ${g.date} на счетах будет ${rub(g.amount)}. Причина: ${g.reason}. Сейчас на счетах ${rub(D.cashflow.start)}.`,
      action: 'Перенести часть платежей, ускорить поступления или сократить закупки.',
      why: 'Кассовый разрыв — это просроченные зарплата, налоги или поставщики.',
      steps: ['Договориться о переносе платежа поставщику', 'Запросить досрочную выплату / проверить дебиторку маркетплейсов', 'Сократить закупку медленно продающихся артикулов', 'Пересчитать прогноз денег'],
      effect: Math.abs(g.amount), due: inDays(1), confidence: 75,
      metric: 'Минимальный остаток в прогнозе на 30 дней ≥ 0 ₽'
    });
  }

  // 5) Отставание от плана месяца
  if (D.plan.plan && D.plan.forecast < D.plan.plan * 0.95 && !D.demo.includes('plan')) {
    const lag = D.plan.plan - D.plan.forecast;
    out.push({
      key: `plan:${isoDay().slice(0, 7)}`, area: 'продажи', urgency: D.plan.day > 20 ? 'сегодня' : 'на неделе',
      title: `Догнать план месяца: не хватает ${rub(lag)}`,
      situation: `Факт ${rub(D.plan.fact)} за ${D.plan.day} дн., прогноз на конец месяца ${rub(D.plan.forecast)} при плане ${rub(D.plan.plan)} (${D.plan.pct}%).`,
      action: 'Усилить продажи лидеров: акции, реклама с допустимой ДРР, пополнение остатков.',
      why: 'Чем раньше скорректировать, тем дешевле догонять.',
      steps: ['Выбрать 3 артикула-лидера с запасом остатка', `Поднять ставки на них при ДРР ≤ ${maxDrr}%`, 'Запустить акцию на маркетплейсе', 'Проверить прогноз через 5 дней'],
      effect: Math.round(lag * (Math.max(5, D.finance.margin) / 100)), due: inDays(2), confidence: 55,
      metric: 'Прогноз выручки на конец месяца ≥ плана'
    });
  }

  // 6) Счета к оплате из документов
  const bills = db.documents.filter((d) => d.ai?.needPay && d.status !== 'Оплачен' && d.status !== 'Архив');
  if (bills.length) {
    const total = bills.reduce((s, d) => s + (d.ai.amount || 0), 0);
    const nearest = bills.map((d) => d.ai.due).filter(Boolean).sort()[0];
    out.push({
      key: 'docs:bills', area: 'документы', urgency: nearest && nearest <= inDays(2) ? 'сегодня' : 'на неделе',
      title: `Оплатить ${bills.length} счёт(а) на ${rub(total)}`,
      situation: `Неоплаченных счетов: ${bills.length}${nearest ? `, ближайший срок — ${nearest.split('-').reverse().join('.')}` : ''}.`,
      action: 'Проверить счета и оплатить с учётом прогноза денег.',
      why: 'Просрочка — пени и риск остановки поставок.',
      steps: ['Сверить счета с договорами', 'Проверить остаток денег и прогноз', 'Оплатить и отметить документы как «Оплачен»'],
      effect: 0, due: nearest || inDays(3), confidence: 90,
      metric: 'Неоплаченных счетов с истёкшим сроком: 0'
    });
  }

  const order = { 'критично': 0, 'сегодня': 1, 'на неделе': 2 };
  return out.sort((a, b) => order[a.urgency] - order[b.urgency] || b.effect - a.effect).slice(0, 15);
}

// ===== Решения от ИИ =====
async function aiDecisions() {
  const snapshot = snapshotForAI();
  const hints = ruleDecisions().map((d) => ({ key: d.key, title: d.title, situation: d.situation }));
  const r = await structured({
    name: 'save_decisions',
    description: 'Сохранить список решений на сегодня',
    system: [
      'Ты — финансовый директор и операционный аналитик продавца на Wildberries и Ozon.',
      'По данным бизнеса составь 3–10 решений, которые владельцу нужно принять СЕГОДНЯ.',
      'Каждое решение — с конкретными цифрами из данных, понятными шагами и оценкой эффекта в ₽ в месяц.',
      'Не выдумывай цифры. Блоки из списка demo — демонстрационные, решения по ним не предлагай.',
      'Учитывай прошлые ответы владельца (pastDecisions): не повторяй отклонённое без новых причин, учитывай причину отказа.',
      'Сначала самое срочное и самое дорогое.'
    ].join('\n'),
    content: [{ type: 'text', text: `Данные бизнеса:\n${JSON.stringify(snapshot)}\n\nПодсказки от встроенных правил (можно использовать, уточнить или отбросить):\n${JSON.stringify(hints)}` }],
    schema: DECISION_SCHEMA,
    maxTokens: 6000
  });
  return r.decisions || [];
}

// ===== Пересчёт и слияние с уже существующими решениями =====
export async function recompute() {
  let fresh;
  let source = 'rules';
  let error = null;
  if (aiEnabled()) {
    try { fresh = await aiDecisions(); source = 'ai'; } catch (e) { error = e.message; }
  }
  if (!fresh) fresh = ruleDecisions();

  const now = new Date().toISOString();
  const byKey = new Map(db.decisions.map((d) => [d.key, d]));
  const next = [];
  // Решения в работе, отложенные, выполненные — не трогаем
  for (const d of db.decisions) if (d.status !== 'new') next.push(d);

  for (const f of fresh) {
    const old = byKey.get(f.key);
    if (old && old.status !== 'new') {
      // Отклонённое не возвращаем 14 дней
      if (old.status === 'rejected' && Date.now() - new Date(old.updatedAt).getTime() > 14 * 86400000) {
        next.splice(next.indexOf(old), 1);
      } else continue;
    }
    next.push({ ...f, id: old?.status === 'new' ? old.id : uid('dec'), status: 'new', source, createdAt: old?.createdAt || now, updatedAt: now, taskIds: [] });
  }
  db.decisions = next;
  db.state.decisionsAt = now;
  db.state.decisionsSource = source;
  db.state.decisionsError = error;
  save();
  return { source, error, count: fresh.length };
}

// Кто по умолчанию исполняет задачи по направлению
function assigneeFor(area) {
  const team = getSettings().team || [];
  const role = { реклама: 'Маркетолог', склад: 'Склад', финансы: 'Бухгалтер', документы: 'Бухгалтер', CRM: 'Менеджер', продажи: 'Менеджер', цены: 'Владелец' }[area] || 'Владелец';
  return team.find((m) => m.role === role)?.name || role;
}

// «Принять»: каждый шаг становится задачей
export function accept(id) {
  const d = db.decisions.find((x) => x.id === id);
  if (!d) return null;
  const priority = d.urgency === 'критично' ? 'high' : d.urgency === 'сегодня' ? 'high' : 'medium';
  for (const step of d.steps) {
    const t = { id: uid('t'), title: step, status: 'todo', priority, due: d.due, assignee: assigneeFor(d.area), byAI: d.source === 'ai', decisionId: d.id, createdAt: new Date().toISOString() };
    db.tasks.push(t);
    d.taskIds.push(t.id);
  }
  d.status = 'inprogress';
  d.updatedAt = new Date().toISOString();
  db.decisionLog.push({ date: isoDay(), key: d.key, title: d.title, answer: 'принято' });
  save();
  return d;
}

export function postpone(id, days = 3) {
  const d = db.decisions.find((x) => x.id === id);
  if (!d) return null;
  d.status = 'postponed';
  d.postponedUntil = new Date(Date.now() + days * 86400000).toISOString();
  d.updatedAt = new Date().toISOString();
  db.decisionLog.push({ date: isoDay(), key: d.key, title: d.title, answer: `отложено на ${days} дн.` });
  save();
  return d;
}

export function reject(id, reason = '') {
  const d = db.decisions.find((x) => x.id === id);
  if (!d) return null;
  d.status = 'rejected';
  d.rejectReason = reason;
  d.updatedAt = new Date().toISOString();
  db.decisionLog.push({ date: isoDay(), key: d.key, title: d.title, answer: 'отклонено', reason });
  save();
  return d;
}

// Отдаём решения с прогрессом по задачам; отложенные возвращаем в «Новые», когда срок вышел
export function listDecisions() {
  let changed = false;
  for (const d of db.decisions) {
    if (d.status === 'postponed' && new Date(d.postponedUntil) < new Date()) { d.status = 'new'; changed = true; }
    if (d.status === 'inprogress' || d.status === 'done') {
      const tasks = db.tasks.filter((t) => d.taskIds.includes(t.id));
      const done = tasks.filter((t) => t.status === 'done').length;
      d.progress = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
      if (d.status === 'inprogress' && tasks.length && done === tasks.length) { d.status = 'done'; d.updatedAt = new Date().toISOString(); changed = true; }
    }
  }
  if (changed) save();
  return { decisions: db.decisions, at: db.state.decisionsAt || null, source: db.state.decisionsSource || null, error: db.state.decisionsError || null, ai: aiEnabled() };
}

// Раз в 5 минут проверяем: не пора ли утренний разбор (час — по часовому поясу из settings)
export function startDecisionScheduler() {
  const tick = () => {
    const S = getSettings();
    const tz = S.timezone || 'Europe/Moscow';
    const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const localDay = `${get('year')}-${get('month')}-${get('day')}`;
    const hour = Number(get('hour'));
    if (hour >= Number(S.decisionHour ?? 8) && db.state.decisionsDay !== localDay) {
      db.state.decisionsDay = localDay;
      recompute().catch((e) => console.error('Центр решений:', e.message));
    }
  };
  setTimeout(tick, 15000);
  setInterval(tick, 5 * 60000);
}
