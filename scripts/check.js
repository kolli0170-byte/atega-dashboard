// Проверка синтаксиса всех JS-файлов проекта и встроенного скрипта index.html.
// Запуск: npm run check
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'data', '.git'].includes(f.name)) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
};
walk(ROOT);

// Скрипт из index.html выносим во временный файл и тоже проверяем
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
const tmp = path.join(os.tmpdir(), 'brandos-inline-check.js');
fs.writeFileSync(tmp, inline);
files.push(tmp);

let ok = true;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { ok = false; console.error(`✗ ${path.relative(ROOT, f)}\n${e.stderr}`); }
}
fs.rmSync(tmp, { force: true });
console.log(ok ? `Синтаксис в порядке: ${files.length} файлов` : 'Есть ошибки');
process.exit(ok ? 0 : 1);
