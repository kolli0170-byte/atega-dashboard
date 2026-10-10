// Коннектор Битрикс24 через входящий вебхук с правами crm.
// Документация: https://apidocs.bitrix24.ru
// Вызов метода: <вебхук><метод>.json
import { request } from '../http.js';
import { num } from '../db.js';

export const enabled = () => !!process.env.BITRIX_WEBHOOK;

function call(method, body = {}) {
  const hook = process.env.BITRIX_WEBHOOK.replace(/\/?$/, '/');
  return request(`${hook}${method}.json`, { method: 'POST', body, source: 'Битрикс24' });
}

export async function sync() {
  // Этапы основной воронки сделок
  const st = await call('crm.status.list', { filter: { ENTITY_ID: 'DEAL_STAGE' }, order: { SORT: 'ASC' } });
  const stages = (st?.result || []).map((s) => ({
    id: s.STATUS_ID,
    name: s.NAME,
    won: s.EXTRA?.SEMANTICS === 'success',
    lost: s.EXTRA?.SEMANTICS === 'failure'
  }));

  // Сделки постранично по 50 (start / next), не больше 40 страниц
  const deals = [];
  let start = 0;
  for (let i = 0; i < 40 && start !== undefined; i++) {
    const r = await call('crm.deal.list', {
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'CLOSEDATE', 'CLOSED', 'CATEGORY_ID'],
      filter: { CATEGORY_ID: 0 },
      start
    });
    for (const d of r?.result || []) {
      deals.push({
        id: String(d.ID),
        c: d.TITLE || `Сделка ${d.ID}`,
        sum: num(d.OPPORTUNITY),
        st: d.STAGE_ID,
        src: 'Битрикс24',
        mgr: d.ASSIGNED_BY_ID ? `id ${d.ASSIGNED_BY_ID}` : '',
        d: String(d.DATE_CREATE || '').slice(0, 10) || null,
        closed: d.CLOSED === 'Y' ? String(d.CLOSEDATE || '').slice(0, 10) : null
      });
    }
    start = r?.next;
  }
  return { provider: 'bitrix', stages, deals };
}

export async function moveDeal(id, stageId) {
  await call('crm.deal.update', { id, fields: { STAGE_ID: stageId } });
}

export async function createDeal({ c, sum, st }) {
  const r = await call('crm.deal.add', { fields: { TITLE: c, OPPORTUNITY: num(sum), ...(st ? { STAGE_ID: st } : {}) } });
  return String(r?.result || '');
}

export async function updateDeal(id, { c, sum }) {
  await call('crm.deal.update', { id, fields: { TITLE: c, OPPORTUNITY: num(sum) } });
}
