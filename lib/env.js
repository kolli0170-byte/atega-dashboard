// Мини-загрузчик .env без библиотек.
// Аналогия: .env — это «сейф» с ключами, а этот модуль — кладовщик,
// который при старте раскладывает содержимое сейфа в process.env.
// Переменные, уже заданные хостингом (Railway), НЕ перезаписываем —
// на сервере главнее настройки хостинга, а .env нужен для локальной работы.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(ROOT, '.env');

if (fs.existsSync(file)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    // Пропускаем пустые строки и комментарии
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Снимаем кавычки: KEY="значение" → значение
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export { ROOT };
