// api/_validateTelegram.js — Проверка подлинности Telegram initData
const crypto = require('crypto');

/**
 * Проверяет HMAC подпись Telegram initData.
 * Возвращает { valid: true, user: {...} } или { valid: false, reason: '...' }
 */
function validateTelegramInitData(initData, botToken) {
  if (!initData || typeof initData !== 'string') {
    return { valid: false, reason: 'Empty initData' };
  }
  if (!botToken) {
    return { valid: false, reason: 'BOT_TOKEN not set' };
  }

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false, reason: 'No hash in initData' };

    // Удаляем hash из параметров и сортируем
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    // Секрет = HMAC-SHA256(botToken, "WebAppData")
    const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    // Вычисленный hash от данных
    const computedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    if (computedHash !== hash) {
      return { valid: false, reason: 'Hash mismatch' };
    }

    // Проверка возраста initData — не старше 24 часов
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
    if (ageSeconds > 86400) {
      return { valid: false, reason: 'initData too old' };
    }

    // Парсим user-данные
    const userJson = params.get('user');
    const user = userJson ? JSON.parse(userJson) : null;

    return { valid: true, user, ageSeconds };
  } catch (e) {
    return { valid: false, reason: 'Parse error: ' + e.message };
  }
}

module.exports = { validateTelegramInitData };
