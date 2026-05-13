// api/_lib/cors.mjs
// CORS-заголовки для API. Вместо открытого '*' — whitelist своих доменов.
//
// Поведение:
//   - Если запрос с Origin из списка → отвечаем тем же Origin (браузер пропускает).
//   - Если Origin отсутствует (server-to-server, либо same-origin) → CORS не нужен,
//     заголовок не ставим, запрос проходит сам по себе.
//   - Если Origin посторонний → заголовок не ставим, браузер блокирует ответ.
//
// Whitelist берётся из env ALLOWED_ORIGINS (через запятую) или дефолтного значения.

const DEFAULT_ORIGINS = [
  'https://viet-change-mini-app.vercel.app',
  // На случай дополнительных Vercel preview-доменов или будущего app.vietchange.com
  // можно добавить через env ALLOWED_ORIGINS="https://app.vietchange.com,https://..."
];

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ORIGINS
);

export function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
