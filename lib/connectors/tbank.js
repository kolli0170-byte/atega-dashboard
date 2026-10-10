// Коннектор Т-Банк Бизнес: счета, остатки и выписка за 60 дней.
// Документация: https://developer.tbank.ru/docs/api
// Названия полей операций в API менялись — разбор сделан с запасными вариантами.
import { request } from '../http.js';
import { isoDay, daysAgo, num } from '../db.js';

const BASE = 'https://business.tbank.ru/openapi/api';

export const enabled = () => !!process.env.TBANK_TOKEN;
const o = () => ({ headers: { Authorization: `Bearer ${process.env.TBANK_TOKEN}` }, source: 'Т-Банк', timeout: 45000 });

export async function sync() {
  const list = await request(`${BASE}/v4/bank-accounts`, o());
  const accounts = (Array.isArray(list) ? list : list?.accounts || []).map((a) => ({
    bank: 'Т-Банк',
    number: a.accountNumber,
    name: a.name || `Счёт …${String(a.accountNumber).slice(-4)}`,
    currency: a.currency || 'RUB',
    // otb — доступный остаток
    balance: num(a.balance?.otb ?? a.balance?.balance ?? a.balance)
  }));

  // Выписка по каждому рублёвому счёту
  const ops = [];
  for (const acc of accounts) {
    if (acc.currency !== 'RUB' && acc.currency !== '643') continue;
    const q = new URLSearchParams({ accountNumber: acc.number, from: `${isoDay(daysAgo(60))}T00:00:00Z`, to: new Date().toISOString() });
    const st = await request(`${BASE}/v1/statement?${q}`, o());
    for (const op of st?.operations || st?.operation || []) {
      const amount = num(op.operationAmount ?? op.accountAmount ?? op.amount);
      // Признак списания в разных версиях: typeOfOperation = Debit / category = debit / знак суммы
      const isDebit = /debit/i.test(op.typeOfOperation || op.category || '') || amount < 0;
      ops.push({
        bank: 'Т-Банк',
        date: String(op.operationDate || op.date || op.drawDate || '').slice(0, 10),
        amount: isDebit ? -Math.abs(amount) : Math.abs(amount),
        party: (isDebit ? (op.receiver?.name || op.recipient) : (op.payer?.name || op.payerName)) || op.counterparty?.name || '',
        purpose: op.payPurpose || op.paymentPurpose || op.description || ''
      });
    }
  }
  return { accounts, ops };
}
