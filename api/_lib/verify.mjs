// api/_lib/verify.mjs
// Единая проверка Telegram Mini App initData (HMAC-SHA256).
// Используется в /api/order и /api/visit.
//
// Алгоритм Telegram (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
//   1) Из initData достать поле hash, остальные ключи отсортировать и склеить как "k=v\n...".
//   2) secret_key = HMAC_SHA256(bot_token, "WebAppData")
//   3) computed   = HMAC_SHA256(data_check_string, secret_key)
//   4) computed === hash → подпись валидна.
//   5) auth_date не старше 1 часа (TTL).
//
// Сравнение — constant-time через crypto.timingSafeEqual.

import crypto from 'crypto';

const TTL_SECONDS = 3600; // 1 час

export function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // constant-time сравнение
  try {
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }

  // TTL: auth_date в секундах
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (!authDate || Date.now() / 1000 - authDate > TTL_SECONDS) return null;

  try {
    return JSON.parse(params.get('user') || '{}');
  } catch {
    return null;
  }
}
