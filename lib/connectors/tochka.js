// Коннектор банка Точка: остатки (обязательно) и выписка (асинхронно — запрос и ожидание).
// Документация: https://enter.tochka.com/doc
import { request } from '../http.js';
import { isoDay, daysAgo, num, sleep } from '../db.js';

const BASE = 'https://enter.tochka.com/uapi/open-banking/v1.0';

export const enabled = () => !!process.env.TOCHKA_TOKEN;
const o = (extra = {}) => ({ headers: { Authorization: `Bearer ${process.env.TOCHKA_TOKEN}` }, source: 'Точка', ...extra });

export async function sync() {
  const r = await request(`${BASE}/balances`, o());
  // На один счёт приходит несколько типов остатка — берём доступный (ClosingAvailable / Expected)
  const byAcc = new Map();
  for (const b of r?.Data?.Balance || []) {
    const prev = byAcc.get(b.accountId);
    if (!prev || /ClosingAvailable|Expected/i.test(b.type)) {
      byAcc.set(b.accountId, { bank: 'Точка', number: b.accountId, name: `Точка …${String(b.accountId).split('/')[0].slice(-4)}`, currency: b.Amount?.currency || 'RUB', balance: num(b.Amount?.amount) });
    }
  }
  const accounts = [...byAcc.values()];

  // Выписка: создаём задание, ждём готовности до ~20 секунд. Если не успела — остатки всё равно есть.
  const ops = [];
  for (const acc of accounts) {
    try {
      const created = await request(`${BASE}/statements`, o({
        method: 'POST',
        body: { Data: { Statement: { accountId: acc.number, startDateTime: isoDay(daysAgo(60)), endDateTime: isoDay() } } }
      }));
      const statementId = created?.Data?.Statement?.statementId;
      if (!statementId) continue;
      for (let i = 0; i < 10; i++) {
        await sleep(2000);
        const st = await request(`${BASE}/accounts/${encodeURIComponent(acc.number)}/statements/${statementId}`, o());
        const s = st?.Data?.Statement?.[0] || st?.Data?.Statement;
        if (s?.status !== 'Ready') continue;
        for (const t of s.Transaction || []) {
          const amount = num(t.Amount?.amount);
          const isDebit = t.creditDebitIndicator === 'Debit';
          ops.push({
            bank: 'Точка',
            date: String(t.documentProcessDate || t.valueDate || '').slice(0, 10),
            amount: isDebit ? -amount : amount,
            party: (isDebit ? t.CreditorParty?.name : t.DebtorParty?.name) || '',
            purpose: t.description || ''
          });
        }
        break;
      }
    } catch (e) {
      console.warn(`Точка: выписка не получена (${e.message})`);
    }
  }
  return { accounts, ops };
}
