// Telegram-бот: принимает пересланные файлы и фото, кладёт в «Документы»
// и отвечает, куда разложил. Работает через getUpdates (без вебхука — проще для старта).
// Документация: https://core.telegram.org/bots/api
import { request } from '../http.js';
import { db, save } from '../db.js';

export const enabled = () => !!process.env.TELEGRAM_BOT_TOKEN;

const api = (method) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
const o = { source: 'Telegram' };

async function download(fileId) {
  const f = await request(`${api('getFile')}?file_id=${fileId}`, o);
  const path = f?.result?.file_path;
  if (!path) throw new Error('Telegram: файл недоступен (больше 20 МБ?)');
  return request(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${path}`, { ...o, raw: true });
}

export async function reply(chatId, text) {
  await request(api('sendMessage'), { ...o, method: 'POST', body: { chat_id: chatId, text } }).catch(() => {});
}

/**
 * Забираем новые сообщения. ingest(files) — общая функция из documents.js,
 * возвращает созданные документы, чтобы бот мог ответить, куда их разложил.
 */
export async function poll(ingest) {
  const offset = (db.state.tgOffset || 0) + 1;
  const r = await request(`${api('getUpdates')}?offset=${offset}&timeout=0`, o);
  for (const u of r?.result || []) {
    db.state.tgOffset = u.update_id;
    save();
    const m = u.message;
    if (!m) continue;
    const chatId = m.chat.id;
    const from = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || 'Telegram';

    // Ограничение по пользователям: TELEGRAM_ALLOWED=123,456 (id или username). Пусто — принимаем всех.
    const allowed = (process.env.TELEGRAM_ALLOWED || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(m.from?.id)) && !allowed.includes(m.from?.username)) {
      await reply(chatId, 'У вас нет доступа к этому боту.');
      continue;
    }

    let file = null;
    if (m.document) {
      file = { name: m.document.file_name || 'документ', mime: m.document.mime_type, id: m.document.file_id };
    } else if (m.photo?.length) {
      // Последнее фото в массиве — самое крупное
      const p = m.photo[m.photo.length - 1];
      file = { name: `фото_${m.message_id}.jpg`, mime: 'image/jpeg', id: p.file_id };
    }
    if (!file) {
      await reply(chatId, 'Пришлите файл или фото документа — я разложу его в BrandOS.');
      continue;
    }

    try {
      const buffer = await download(file.id);
      const docs = await ingest([{ source: 'Telegram', name: file.name, buffer, mime: file.mime, from, date: new Date(m.date * 1000).toISOString(), externalId: `tg:${u.update_id}` }]);
      const d = docs[0];
      const parts = [`Принял «${file.name}».`];
      if (d?.ai) {
        parts.push(`Тип: ${d.ai.type}, раздел: ${d.ai.section}.`);
        if (d.ai.amount) parts.push(`Сумма: ${Math.round(d.ai.amount).toLocaleString('ru-RU')} ₽.`);
        if (d.ai.needSign) parts.push('Создал задачу «подписать».');
        if (d.ai.needPay) parts.push('Создал задачу «оплатить».');
      }
      await reply(chatId, parts.join(' '));
    } catch (e) {
      await reply(chatId, `Не получилось сохранить файл: ${e.message}`);
    }
  }
}
