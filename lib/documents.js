// Приём документов из любых источников: почта, Telegram, ЭДО, WB, ручная загрузка.
// Конвейер одинаковый для всех: сохранить файл → прочитать (ИИ или правила) →
// разложить по разделу → при необходимости создать задачи «подписать» / «оплатить».
import fs from 'node:fs';
import path from 'node:path';
import { db, save, uid, FILES_DIR, isoDay } from './db.js';
import { aiEnabled, structured } from './ai.js';

// Схема ответа ИИ по документу — «бланк», который модель обязана заполнить
const DOC_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['Счёт', 'Акт', 'УПД', 'Счёт-фактура', 'Договор', 'Накладная', 'Отчёт', 'Претензия', 'Письмо', 'Другое'] },
    counterparty: { type: 'string', description: 'Название контрагента, как в документе. Пустая строка, если не указан.' },
    amount: { type: ['number', 'null'], description: 'Итоговая сумма в рублях или null' },
    date: { type: ['string', 'null'], description: 'Дата документа YYYY-MM-DD или null' },
    due: { type: ['string', 'null'], description: 'Срок оплаты/подписания YYYY-MM-DD или null' },
    needSign: { type: 'boolean', description: 'Нужна ли наша подпись' },
    needPay: { type: 'boolean', description: 'Нужно ли нам оплатить' },
    section: { type: 'string', enum: ['Финансы', 'Налоги', 'Поставки', 'Маркетплейсы', 'Реклама', 'CRM', 'Склад', 'Прочее'] },
    summary: { type: 'string', description: 'Одно-два предложения: что это за документ и что с ним делать' }
  },
  required: ['type', 'counterparty', 'amount', 'date', 'due', 'needSign', 'needPay', 'section', 'summary']
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const TEXT_EXT = /\.(txt|csv|xml|html?|json|md)$/i;

// Чтение документа через Claude: PDF и фото отправляем как есть, текстовые — текстом
async function analyzeWithAI(file) {
  const content = [];
  const b64 = file.buffer.toString('base64');
  if (file.mime === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
  } else if (IMAGE_TYPES.includes(file.mime)) {
    content.push({ type: 'image', source: { type: 'base64', media_type: file.mime, data: b64 } });
  } else if (TEXT_EXT.test(file.name) || /^text\/|xml|json/.test(file.mime || '')) {
    content.push({ type: 'text', text: `Содержимое файла:\n${file.buffer.toString('utf8').slice(0, 60000)}` });
  }
  content.push({
    type: 'text',
    text: `Файл «${file.name}» из источника «${file.source}», отправитель: ${file.from || 'неизвестен'}. Сегодня ${isoDay()}. ` +
      'Прочитай документ и заполни поля. Если содержимое недоступно — опирайся на имя файла и честно отметь это в summary.'
  });
  const r = await structured({
    name: 'save_document',
    description: 'Сохранить распознанные реквизиты документа',
    system: 'Ты бухгалтер-ассистент продавца на маркетплейсах. Аккуратно извлекаешь реквизиты из первичных документов. Не выдумывай: если поля нет — null или пустая строка.',
    schema: DOC_SCHEMA,
    content,
    maxTokens: 1000
  });
  return { ...r, by: 'ai' };
}

// Без ключа ИИ — простые правила по имени файла. Честно помечаем by: 'rules'.
function analyzeWithRules(file) {
  const n = file.name.toLowerCase();
  const rule = (re) => re.test(n);
  let type = 'Другое';
  if (rule(/сч[её]т-?фактур|invoice-?factur/)) type = 'Счёт-фактура';
  else if (rule(/сч[её]т|invoice|bill/)) type = 'Счёт';
  else if (rule(/упд/)) type = 'УПД';
  else if (rule(/акт/)) type = 'Акт';
  else if (rule(/договор|contract/)) type = 'Договор';
  else if (rule(/наклад|торг/)) type = 'Накладная';
  else if (rule(/отч[её]т|report/)) type = 'Отчёт';
  const needPay = type === 'Счёт';
  const needSign = ['Акт', 'УПД', 'Договор'].includes(type) || !!file.hint?.needSign;
  const section = ['WB', 'Ozon', 'Яндекс Маркет'].includes(file.source) ? 'Маркетплейсы' : needPay ? 'Финансы' : type === 'Накладная' ? 'Поставки' : 'Прочее';
  return {
    type, counterparty: file.from || '', amount: null, date: isoDay(file.date), due: null,
    needSign, needPay, section,
    summary: 'Разобрано по имени файла: ИИ не подключён (нет ANTHROPIC_API_KEY).',
    by: 'rules'
  };
}

// Задача со ссылкой на документ
function taskFor(doc, kind) {
  const verb = kind === 'sign' ? 'Подписать' : 'Оплатить';
  const what = `${doc.ai.type.toLowerCase()}${doc.ai.counterparty ? ` от ${doc.ai.counterparty}` : ''}`;
  const sum = doc.ai.amount ? ` на ${Math.round(doc.ai.amount).toLocaleString('ru-RU')} ₽` : '';
  return {
    id: uid('t'),
    title: `${verb} ${what}${sum}`,
    status: 'todo',
    priority: kind === 'pay' ? 'high' : 'medium',
    due: doc.ai.due || isoDay(Date.now() + 3 * 86400000),
    assignee: kind === 'pay' ? 'Бухгалтер' : 'Владелец',
    byAI: doc.ai.by === 'ai',
    docId: doc.id,
    createdAt: new Date().toISOString()
  };
}

/**
 * Главная функция конвейера.
 * files: [{source, name, buffer, mime, from, date, externalId, hint?}]
 * Возвращает созданные документы.
 */
export async function ingest(files) {
  const created = [];
  for (const file of files) {
    // Не принимаем один и тот же документ дважды
    if (file.externalId && db.documents.some((d) => d.externalId === file.externalId)) continue;

    const id = uid('d');
    const ext = path.extname(file.name || '').slice(0, 10) || '';
    const stored = `${id}${ext}`;
    fs.writeFileSync(path.join(FILES_DIR, stored), file.buffer);

    const doc = {
      id, source: file.source, name: file.name, mime: file.mime || 'application/octet-stream',
      size: file.buffer.length, from: file.from || '', date: file.date || new Date().toISOString(),
      externalId: file.externalId || null, file: stored, status: 'Новый', ai: null, error: null, taskIds: []
    };

    try {
      doc.ai = aiEnabled() && file.buffer.length < 25 * 1024 * 1024 ? await analyzeWithAI(file) : analyzeWithRules(file);
    } catch (e) {
      // ИИ не ответил — не теряем документ: разбираем правилами и показываем причину
      doc.error = e.message;
      doc.ai = analyzeWithRules(file);
    }
    if (file.hint?.needSign) doc.ai.needSign = true;

    doc.status = doc.ai.needSign ? 'Ждёт подписи' : 'Обработан';
    if (doc.ai.needSign) { const t = taskFor(doc, 'sign'); db.tasks.push(t); doc.taskIds.push(t.id); }
    if (doc.ai.needPay) { const t = taskFor(doc, 'pay'); db.tasks.push(t); doc.taskIds.push(t.id); }

    db.documents.unshift(doc);
    created.push(doc);
  }
  if (created.length) save();
  return created;
}
