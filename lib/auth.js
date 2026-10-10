// Вход по паролю для всей команды.
// Аналогия: пароль — это ключ от двери офиса, а cookie — пропуск на 30 дней.
// Пропуск подписан секретом сервера (HMAC): подделать его без секрета нельзя.
import crypto from 'node:crypto';

const COOKIE = 'bos_session';
const TTL = 30 * 86400000; // 30 дней

export const onHosting = () => !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === 'production');
// trim(): при вставке в панель хостинга легко захватить пробел или перевод строки — и пароль «не подходит»
const appPassword = () => (process.env.APP_PASSWORD || '').trim();
export const authEnabled = () => !!appPassword();

// Секрет подписи: SESSION_SECRET или производный от пароля (смена пароля = выход у всех)
const secret = () => (process.env.SESSION_SECRET || '').trim() || crypto.createHash('sha256').update(`brandos:${appPassword()}`).digest('hex');
const sign = (value) => crypto.createHmac('sha256', secret()).update(value).digest('base64url');

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function isAuthed(req) {
  if (!authEnabled()) return true;
  const token = parseCookies(req)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  return Number(exp) > Date.now() && safeEqual(sig, sign(exp));
}

export function checkPassword(password) {
  return authEnabled() && safeEqual(String(password ?? '').trim(), appPassword());
}

export function sessionCookie(req) {
  const exp = String(Date.now() + TTL);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${secure}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Защита от перебора: не больше 10 попыток за 15 минут с одного IP
const attempts = new Map();
export function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60000);
  attempts.set(ip, list);
  return list.length >= 10;
}
export const recordFail = (ip) => attempts.set(ip, [...(attempts.get(ip) || []), Date.now()]);

// Страница входа — в тех же цветах, что и дашборд
export function loginPage({ error = '', company = 'BrandOS', setup = false } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход — ${esc(company)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0A0C1C;--s1:#13162E;--line:#2A2F57;--text:#ECEEFB;--muted:#A3A9D1;--blue:#4C8DFF;--violet:#9A6BFF;--red:#FF5D7A}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:16px/1.5 Inter,system-ui,sans-serif}
  .login{width:100%;max-width:400px;background:var(--s1);border:1px solid var(--line);border-radius:16px;padding:32px}
  .login__mark{width:40px;height:40px;border-radius:12px;background:var(--violet);box-shadow:0 0 24px rgba(154,107,255,.55);margin-bottom:24px}
  h1{font-size:24px;margin:0 0 8px}
  p{color:var(--muted);margin:0 0 24px}
  label{display:block;font-size:14px;color:var(--muted);margin-bottom:8px}
  input{width:100%;min-height:48px;padding:12px 16px;border-radius:12px;border:1px solid var(--line);background:#0E1126;color:var(--text);font:inherit}
  input:focus{outline:2px solid var(--blue);outline-offset:2px}
  button{width:100%;min-height:48px;margin-top:16px;border:0;border-radius:12px;background:var(--blue);color:#fff;font:600 16px Inter,sans-serif;cursor:pointer}
  button:focus-visible{outline:2px solid #fff;outline-offset:2px}
  .login__error{color:var(--red);margin:16px 0 0;font-size:14px}
</style></head>
<body><main class="login">
  <div class="login__mark" aria-hidden="true"></div>
  <h1>${esc(company)}</h1>
  ${setup
    ? `<p>Вход не настроен. Добавьте переменную APP_PASSWORD в настройках хостинга (Railway → Variables) и перезапустите сервис.</p>`
    : `<p>Введите пароль команды, чтобы открыть дашборд.</p>
  <form method="post" action="/login">
    <label for="password">Пароль</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
    <button type="submit">Войти</button>
    ${error ? `<p class="login__error" role="alert">${esc(error)}</p>` : ''}
  </form>`}
</main></body></html>`;
}
