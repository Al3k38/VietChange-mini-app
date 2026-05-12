// api/_lib/escape.mjs
// Экранирование HTML для безопасной вставки клиентских полей в сообщения Telegram
// (parse_mode: HTML).
// Без этого клиент может прислать в `comment` или реквизитах теги вроде
// "</code><a href='evil'>...", которые сломают парсер или встроят ссылку.

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
