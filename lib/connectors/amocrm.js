// Коннектор amoCRM: этапы воронки и сделки + запись переноса сделки обратно в CRM.
// Документация: https://www.amocrm.ru/developers
import { request } from '../http.js';
import { num } from '../db.js';

export const enabled = () => !!(process.env.AMO_SUBDOMAIN && process.env.AMO_TOKEN);

const base = () => `https://${process.env.AMO_SUBDOMAIN}.amocrm.ru/api/v4`;
const o = (extra = {}) => ({ headers: { Authorization: `Bearer ${process.env.AMO_TOKEN}` }, source: 'amoCRM', ...extra });

// Служебные статусы amoCRM: 142 — «Успешно реализовано», 143 — «Закрыто и не реализовано»
const WON = 142;
const LOST = 143;

export async function sync() {
  // Воронка: берём указанную в AMO_PIPELINE_ID или главную
  const p = await request(`${base()}/leads/pipelines`, o());
  const pipelines = p?._embedded?.pipelines || [];
  const pipeline = pipelines.find((x) => String(x.id) === process.env.AMO_PIPELINE_ID) || pipelines.find((x) => x.is_main) || pipelines[0];
  if (!pipeline) return { provider: 'amocrm', stages: [], deals: [] };

  const stages = (pipeline._embedded?.statuses || [])
    .sort((a, b) => a.sort - b.sort)
    .map((s) => ({ id: String(s.id), name: s.name, won: s.id === WON, lost: s.id === LOST }));

  // Имена менеджеров (не критично, если метод недоступен)
  const users = new Map();
  try {
    const u = await request(`${base()}/users?limit=250`, o());
    for (const x of u?._embedded?.users || []) users.set(x.id, x.name);
  } catch { /* ок */ }

  // Сделки постранично по 250, не больше 20 страниц
  const deals = [];
  for (let page = 1; page <= 20; page++) {
    const r = await request(`${base()}/leads?limit=250&page=${page}&filter[pipeline_id]=${pipeline.id}`, o());
    // amoCRM на пустой странице отвечает 204 без тела
    const leads = r?._embedded?.leads || [];
    for (const l of leads) {
      deals.push({
        id: String(l.id),
        c: l.name || `Сделка ${l.id}`,
        sum: num(l.price),
        st: String(l.status_id),
        src: 'amoCRM',
        mgr: users.get(l.responsible_user_id) || '',
        d: l.created_at ? new Date(l.created_at * 1000).toISOString().slice(0, 10) : null,
        closed: l.closed_at ? new Date(l.closed_at * 1000).toISOString().slice(0, 10) : null
      });
    }
    if (leads.length < 250) break;
  }
  return { provider: 'amocrm', pipelineId: String(pipeline.id), stages, deals };
}

// Перенос сделки на другой этап
export async function moveDeal(id, stageId) {
  await request(`${base()}/leads/${id}`, o({ method: 'PATCH', body: { status_id: Number(stageId) } }));
}

// Новая сделка
export async function createDeal({ c, sum, st, pipelineId }) {
  const body = [{ name: c, price: Math.round(num(sum)), ...(st ? { status_id: Number(st) } : {}), ...(pipelineId ? { pipeline_id: Number(pipelineId) } : {}) }];
  const r = await request(`${base()}/leads`, o({ method: 'POST', body }));
  return String(r?._embedded?.leads?.[0]?.id || '');
}

export async function updateDeal(id, { c, sum }) {
  await request(`${base()}/leads/${id}`, o({ method: 'PATCH', body: { name: c, price: Math.round(num(sum)) } }));
}
