// Документы из кабинета Wildberries (отчёты, акты). У токена должна быть категория «Документы».
// Документация: https://dev.wildberries.ru
import { request } from '../http.js';
import { db, save } from '../db.js';

const BASE = 'https://documents-api.wildberries.ru';

export const enabled = () => !!(process.env.WB_DOCS_TOKEN || process.env.WB_TOKEN) && process.env.WB_DOCS !== 'off';
const o = () => ({ headers: { Authorization: process.env.WB_DOCS_TOKEN || process.env.WB_TOKEN }, source: 'WB Документы' });

export async function sync() {
  const list = await request(`${BASE}/api/v1/documents/list?limit=30`, o());
  const docs = list?.data?.documents || [];
  const seen = new Set(db.state.wbDocsSeen || []);
  const files = [];

  for (const d of docs) {
    if (seen.has(d.serviceName)) continue;
    seen.add(d.serviceName);
    const ext = (d.extensions || []).includes('pdf') ? 'pdf' : (d.extensions || [])[0] || 'pdf';
    try {
      const r = await request(`${BASE}/api/v1/documents/download?serviceName=${encodeURIComponent(d.serviceName)}&extension=${ext}`, o());
      // Файл приходит в base64
      const b64 = r?.data?.document;
      if (!b64) continue;
      files.push({
        source: 'WB',
        name: r.data.fileName || `${d.name || d.serviceName}.${ext}`,
        buffer: Buffer.from(b64, 'base64'),
        mime: ext === 'pdf' ? 'application/pdf' : ext === 'zip' ? 'application/zip' : 'application/octet-stream',
        from: 'Wildberries',
        date: d.creationTime || new Date().toISOString(),
        externalId: `wbdoc:${d.serviceName}`
      });
    } catch (e) {
      console.warn(`WB документ ${d.serviceName} не скачан: ${e.message}`);
    }
  }
  db.state.wbDocsSeen = [...seen].slice(-2000);
  save();
  return files;
}
