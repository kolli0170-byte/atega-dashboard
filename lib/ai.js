// Работа с Claude API через официальный SDK @anthropic-ai/sdk.
// Ключ ANTHROPIC_API_KEY живёт только на сервере — браузер его никогда не видит.
//
// Как получаем «строгий JSON»: описываем инструмент (tool) с JSON-схемой и
// принуждаем модель его вызвать (tool_choice). Аналогия — бланк с полями:
// модель не может «написать письмо своими словами», она обязана заполнить бланк.
import Anthropic from '@anthropic-ai/sdk';

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

let client = null;
const anthropic = () => (client ||= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

// Понятный текст ошибки для интерфейса
function explain(e) {
  const s = e?.status;
  if (s === 401) return 'Claude API: ключ ANTHROPIC_API_KEY не подходит.';
  if (s === 402 || /credit|billing/i.test(e?.message || '')) return 'Claude API: закончился баланс — пополните его в console.anthropic.com.';
  if (s === 429) return 'Claude API: превышен лимит запросов, попробуйте через минуту.';
  if (s === 404) return `Claude API: модель «${MODEL()}» недоступна. Укажите другую в ANTHROPIC_MODEL.`;
  return `Claude API: ${e?.message || 'неизвестная ошибка'}`;
}

/**
 * Запрос со строгой JSON-схемой ответа.
 * content — массив блоков сообщения (текст, PDF, картинка).
 */
export async function structured({ system, content, schema, name, description, maxTokens = 4000 }) {
  try {
    const res = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: maxTokens,
      system,
      tools: [{ name, description, input_schema: schema }],
      tool_choice: { type: 'tool', name },
      messages: [{ role: 'user', content }]
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block) throw new Error('модель не вернула структурированный ответ');
    return block.input;
  } catch (e) {
    throw new Error(explain(e));
  }
}

/**
 * Чат по живым данным бизнеса.
 * history — [{role:'user'|'assistant', content:'...'}], snapshot — сводка данных.
 */
export async function chat(history, snapshot) {
  const system = [
    'Ты — ИИ-ассистент дашборда BrandOS для продавца на Wildberries и Ozon.',
    'Отвечай по-русски, коротко и по делу, с конкретными цифрами из данных ниже.',
    'Используй ТОЛЬКО эти данные. Если нужной информации нет — прямо скажи, что данных нет, и какой источник нужно подключить.',
    'Не выдумывай цифры. Блоки из списка "demo" — демонстрационные, предупреждай об этом.',
    'Суммы — в рублях с разделителями разрядов.',
    '',
    'ДАННЫЕ БИЗНЕСА (JSON):',
    JSON.stringify(snapshot)
  ].join('\n');

  try {
    const res = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: 1500,
      system,
      messages: history.slice(-20).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 8000) }))
    });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  } catch (e) {
    throw new Error(explain(e));
  }
}
