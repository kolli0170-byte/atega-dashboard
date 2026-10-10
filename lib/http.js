// Общий HTTP-клиент для всех коннекторов.
// Зачем отдельный модуль: у каждого API свои капризы (лимиты, таймауты, 5xx).
// Здесь в одном месте: таймаут, повтор при 429/5xx и ПОНЯТНЫЙ текст ошибки,
// который потом показывается на странице «Интеграции».
import { sleep } from './db.js';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// Переводим HTTP-коды на человеческий язык
function humanize(status, text, source) {
  const who = source ? `${source}: ` : '';
  if (status === 401 || status === 403) {
    return `${who}ключ не подходит или у него нет прав на этот раздел (код ${status}). Проверьте ключ в .env и отмеченные категории/роль.`;
  }
  if (status === 429) return `${who}превышен лимит запросов. Следующая синхронизация повторит попытку.`;
  if (status === 404) return `${who}метод не найден (404) — возможно, API изменился. Сверьтесь с документацией.`;
  if (status >= 500) return `${who}сервис временно недоступен (код ${status}).`;
  const short = String(text || '').replace(/\s+/g, ' ').slice(0, 200);
  return `${who}ошибка ${status}${short ? `: ${short}` : ''}`;
}

/**
 * request(url, options)
 * options: method, headers, body (объект → JSON), timeout (мс), retries,
 *          source (имя сервиса для текста ошибки), raw (вернуть Buffer),
 *          maxWait (максимальная пауза при 429, мс)
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET', headers = {}, body, timeout = 30000, retries = 2,
    source = '', raw = false, maxWait = 65000
  } = opts;

  const isJsonBody = body && typeof body === 'object' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body);
  const finalHeaders = { Accept: 'application/json', ...headers };
  if (isJsonBody) finalHeaders['Content-Type'] = 'application/json';

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: finalHeaders,
        body: isJsonBody ? JSON.stringify(body) : body,
        signal: AbortSignal.timeout(timeout)
      });
    } catch (e) {
      // Сетевые ошибки и таймаут — тоже повторяем
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      const why = e.name === 'TimeoutError' ? 'сервер не ответил вовремя (таймаут)' : `нет соединения (${e.message})`;
      throw new ApiError(`${source ? source + ': ' : ''}${why}`);
    }

    // 429 и 5xx — подождать и повторить. Для 429 уважаем заголовок Retry-After.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const wait = res.status === 429 ? Math.min(retryAfter || 60000, maxWait) : 3000 * (attempt + 1);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(humanize(res.status, text, source), res.status);
    }

    if (raw) return Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    if (type.includes('json')) return res.json();
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }
}
