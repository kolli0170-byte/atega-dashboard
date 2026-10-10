// Документы из почты по IMAP: забираем вложения из новых писем.
// Нужен ПАРОЛЬ ПРИЛОЖЕНИЯ (не обычный пароль) и включённый IMAP в настройках ящика.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, save } from '../db.js';

export const enabled = () => !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);

export async function sync() {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false
  });

  try {
    await client.connect();
  } catch (e) {
    throw new Error(`Почта: не удалось войти (${e.responseText || e.message}). Нужен пароль приложения и включённый IMAP.`);
  }

  const files = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const lastUid = db.state.imapLastUid || 0;
    // Первый запуск — смотрим письма за 7 дней, дальше — всё, что новее последнего UID
    const query = lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 7 * 86400000) };
    let maxUid = lastUid;
    let count = 0;
    for await (const msg of client.fetch(query, { uid: true, source: true })) {
      if (msg.uid <= lastUid) continue;
      maxUid = Math.max(maxUid, msg.uid);
      if (++count > 30) break; // не больше 30 писем за раз
      const mail = await simpleParser(msg.source);
      for (const att of mail.attachments || []) {
        // Картинки-подписи из тела письма пропускаем, берём настоящие вложения
        if (att.contentDisposition === 'inline' && !/pdf/i.test(att.contentType)) continue;
        files.push({
          source: 'Почта',
          name: att.filename || 'вложение',
          buffer: att.content,
          mime: att.contentType,
          from: mail.from?.text || '',
          date: (mail.date || new Date()).toISOString(),
          externalId: `imap:${msg.uid}:${att.checksum || att.filename}`
        });
      }
    }
    db.state.imapLastUid = maxUid;
    save();
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return files;
}
