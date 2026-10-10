// ЭДО Диадок: входящие акты и УПД, в том числе ожидающие подписи.
// ЭКСПЕРИМЕНТАЛЬНЫЙ коннектор — написан по документации, проверяйте на реальном ящике.
// Документация: https://developer.kontur.ru
import { request } from '../http.js';
import { db, save } from '../db.js';

const BASE = 'https://diadoc-api.kontur.ru';

export const enabled = () => !!(process.env.DIADOC_API_KEY && process.env.DIADOC_LOGIN && process.env.DIADOC_PASSWORD);

export async function sync() {
  const client = `DiadocAuth ddauth_api_client_id=${process.env.DIADOC_API_KEY}`;
  const token = await request(`${BASE}/V3/Authenticate?type=password`, {
    method: 'POST',
    headers: { Authorization: client },
    body: { login: process.env.DIADOC_LOGIN, password: process.env.DIADOC_PASSWORD },
    source: 'Диадок'
  });
  const auth = { Authorization: `${client},ddauth_token=${String(token).replace(/"/g, '')}` };

  const orgs = await request(`${BASE}/GetMyOrganizations`, { headers: auth, source: 'Диадок' });
  const boxId = orgs?.Organizations?.[0]?.Boxes?.[0]?.BoxId;
  if (!boxId) throw new Error('Диадок: у пользователя нет ящика организации');

  const list = await request(`${BASE}/V3/GetDocuments?boxId=${boxId}&filterCategory=Any.InboundNotRevoked`, { headers: auth, source: 'Диадок' });
  const seen = new Set(db.state.diadocSeen || []);
  const files = [];

  for (const d of (list?.Documents || []).slice(0, 30)) {
    const key = `${d.MessageId}:${d.EntityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const content = await request(`${BASE}/V4/GetEntityContent?boxId=${boxId}&messageId=${d.MessageId}&entityId=${d.EntityId}`, { headers: auth, raw: true, source: 'Диадок' });
      files.push({
        source: 'ЭДО',
        name: d.FileName || `${d.TypeNamedId || 'документ'}_${d.DocumentNumber || ''}.xml`,
        buffer: content,
        mime: /\.pdf$/i.test(d.FileName || '') ? 'application/pdf' : 'application/xml',
        from: d.CounteragentBoxId || 'Диадок',
        date: d.CreationTimestamp ? new Date(d.CreationTimestamp).toISOString() : new Date().toISOString(),
        externalId: `diadoc:${key}`,
        // Подсказка для разбора: в Диадоке видно, ждёт ли документ подписи
        hint: { needSign: /WaitingForRecipientSignature|RecipientSignatureRequestRejected/i.test(d.DocflowStatus?.PrimaryStatus?.StatusText || d.RecipientResponseStatus || '') }
      });
    } catch (e) {
      console.warn(`Диадок: документ ${key} не скачан (${e.message})`);
    }
  }
  db.state.diadocSeen = [...seen].slice(-2000);
  save();
  return files;
}
