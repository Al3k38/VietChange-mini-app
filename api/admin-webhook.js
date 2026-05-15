// api/admin-webhook.js
// Vercel Serverless Function — webhook для админ-бота VietChangeAdminBot
// Обрабатывает команды менеджеров: /check, /help
//
// SECURITY: проверяем заголовок X-Telegram-Bot-Api-Secret-Token.
// После деплоя нужно ОДИН РАЗ переустановить webhook с secret_token:
//   curl "https://api.telegram.org/bot<ADMIN_BOT_TOKEN>/setWebhook" \
//        -d "url=https://<deploy>/api/admin-webhook" \
//        -d "secret_token=<ADMIN_WEBHOOK_SECRET>"
// Telegram будет слать этот токен в заголовке каждого update —
// без него мы не пропускаем запрос (любой, кто узнает URL, будет 403).

import { assessRisk, formatRiskBlock } from './risk-check.mjs';
import { esc as escapeHtml } from './_lib/escape.mjs';
import { sheetsPost } from './_lib/sheets.mjs';
import {
  addToBlacklist,
  removeFromBlacklist,
  listBlacklist,
  checkBlacklist,
} from './_lib/blacklist.mjs';

const ADMIN_BOT_TOKEN      = process.env.ADMIN_BOT_TOKEN;
const ADMIN_WEBHOOK_SECRET = process.env.ADMIN_WEBHOOK_SECRET;
const GROUP_ID             = process.env.GROUP_ID;
const RISK_THREAD_ID       = process.env.RISK_THREAD_ID;

// Список менеджеров читается строго из env ADMIN_USER_IDS (через запятую).
// Без env список пустой → никто не админ → команды /check возвращают «доступ только менеджерам».
// (Раньше тут был hardcoded fallback с реальными user ID, теперь убран —
//  не светим админские контакты в публичной git-истории.)
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
if (ADMIN_USER_IDS.length === 0) {
  console.error('[admin-webhook] ADMIN_USER_IDS env not set — admin commands disabled');
}

function nowVN() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString()
    .replace('T', ' ').substring(0, 16) + ' (GMT+7)';
}

async function tgSend(chatId, text, threadId, replyToMessageId) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (threadId) body.message_thread_id = parseInt(threadId);
    if (replyToMessageId) body.reply_to_message_id = parseInt(replyToMessageId);
    const res = await fetch(`https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch(e) { console.error('tgSend error:', e); }
}

async function findClientByUserId(userId) {
  if (!userId) return null;
  const data = await sheetsPost({
    type: 'lookup_userid',
    userId: String(userId),
  });
  return data && data.found ? data : null;
}

async function findClientByUsername(username) {
  if (!username) return null;
  const cleanUsername = String(username).replace(/^@/, '').toLowerCase().trim();
  if (!cleanUsername) return null;
  const data = await sheetsPost({
    type: 'lookup_username',
    username: cleanUsername,
  });
  return data && data.found ? data : null;
}

// Строит строку «Профиль:» для DM-уведомлений. Если знаем username из
// нашей БД (Визиты) — даём ссылку https://t.me/USERNAME (всегда кликается).
// Иначе fallback на tg://user?id=... — может не сработать у админа если
// бот никогда не видел этого юзера. В таком случае показываем ID копируемо.
async function buildProfileLine_(userId) {
  try {
    const found = await findClientByUserId(userId);
    if (found && found.username) {
      const u = String(found.username).replace(/^@/, '').trim();
      if (u) {
        return `<b>Профиль:</b> <a href="https://t.me/${encodeURIComponent(u)}">@${escapeHtml(u)}</a>`;
      }
    }
  } catch(e) { /* skip */ }
  // Username неизвестен — пытаемся через tg:// схему (может не кликаться)
  // плюс показываем ID копируемо для ручного поиска.
  return `<b>Профиль:</b> <a href="tg://user?id=${userId}">открыть в Telegram</a> ` +
    `<i>(если не кликается — скопируй ID и найди вручную)</i>`;
}

async function getClientHistory(userId, username, firstName) {
  if (!userId) return { firstSeen: null, nameChanges: 0, usernameChanges: 0 };
  const data = await sheetsPost({
    type: 'visit',
    userId: String(userId),
    username: username || '',
    firstName: firstName || '',
    datetime: nowVN(),
    checkOnly: true,
  });
  if (!data) return { firstSeen: null, nameChanges: 0, usernameChanges: 0 };
  return {
    firstSeen: data.firstSeen || null,
    nameChanges: data.nameChanges || 0,
    usernameChanges: data.usernameChanges || 0,
  };
}

async function handleCheckCommand(message, args) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id || null;
  const replyToId = message.message_id;
  const senderId = String(message.from.id);

  if (!ADMIN_USER_IDS.includes(senderId)) {
    await tgSend(chatId, '⛔ Команда доступна только менеджерам.', threadId, replyToId);
    return;
  }

  if (!args || !args.trim()) {
    await tgSend(chatId,
      '<b>Использование:</b>\n' +
      '<code>/check 7371024261</code> — по ID\n' +
      '<code>/check @username</code> — по username\n\n' +
      '<i>Поиск по username работает только для клиентов из БД.</i>',
      threadId, replyToId);
    return;
  }

  const query = args.trim();
  let targetUserId = null;
  let targetUsername = '';
  let targetFirstName = 'Клиент';

  if (/^\d{5,}$/.test(query)) {
    targetUserId = query;
    const found = await findClientByUserId(targetUserId);
    if (found) {
      targetUsername = found.username || '';
      targetFirstName = found.firstName || 'Клиент';
    }
  } else {
    const found = await findClientByUsername(query);
    if (found) {
      targetUserId = String(found.userId);
      targetUsername = found.username || query;
      targetFirstName = found.firstName || 'Клиент';
    } else {
      await tgSend(chatId,
        `❌ Клиент <code>${escapeHtml(query)}</code> не найден в нашей БД.\n\n` +
        'Если знаете <b>userId</b> — введите его вместо username:\n' +
        '<code>/check 1234567890</code>',
        threadId, replyToId);
      return;
    }
  }

  const history = await getClientHistory(targetUserId, targetUsername, targetFirstName);

  const risk = await assessRisk(targetUserId, {
    username: targetUsername,
    rubEquiv: 0,
    photoUrl: '',
    firstSeen: history.firstSeen,
    nameChanges: history.nameChanges,
    usernameChanges: history.usernameChanges,
  });

  console.warn(`[admin /check] manager=${senderId} target=${targetUserId} risk=${risk.summary}`);

  // Дополнительно: проверка blacklist (по userId — единственный идентификатор тут).
  const blMatch = await checkBlacklist({ userId: targetUserId });
  let blacklistBlock = '';
  if (blMatch) {
    blacklistBlock =
      `\n\n⛔ <b>В ЧЁРНОМ СПИСКЕ</b>\n` +
      `<b>Совпадение:</b> ${escapeHtml(blMatch.type)} = <code>${escapeHtml(blMatch.value)}</code>\n` +
      `<b>Причина:</b> ${escapeHtml(blMatch.reason || '—')}`;
  }

  const usernameLine = targetUsername
    ? `<b>Username:</b> ${escapeHtml(targetUsername.startsWith('@') ? targetUsername : '@' + targetUsername)}\n`
    : '';
  const clientLink = `<a href="tg://user?id=${targetUserId}">${escapeHtml(targetFirstName)}</a>`;

  const senderName = message.from.first_name || 'Менеджер';
  const senderLink = `<a href="tg://user?id=${senderId}">${escapeHtml(senderName)}</a>`;

  const msg = [
    `🔎 <b>Ручная проверка клиента</b>`,
    `📅 ${nowVN()}`,
    ``,
    `<b>Имя:</b> ${clientLink}`,
    usernameLine ? usernameLine.trim() : null,
    `<b>ID:</b> <code>${targetUserId}</code>`,
    ``,
    `<i>Запросил: ${senderLink}</i>`,
  ].filter(Boolean).join('\n');

  const riskBlock = formatRiskBlock(risk);
  const fullMsg = msg + blacklistBlock + '\n' + riskBlock;

  if (GROUP_ID && RISK_THREAD_ID) {
    await tgSend(GROUP_ID, fullMsg, RISK_THREAD_ID);
  }

  if (chatId !== Number(GROUP_ID) || threadId !== Number(RISK_THREAD_ID)) {
    await tgSend(chatId,
      `✅ Проверка завершена. Результат в топике <b>Risk Check</b>.\n` +
      `Уровень риска: ${risk.emoji} <b>${risk.summary}</b>`,
      threadId, replyToId);
  }
}

// ─── /blacklist add/remove/list ─────────────────────────────
async function handleBlacklistCommand(message, args) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id || null;
  const replyToId = message.message_id;
  const senderId = String(message.from.id);

  if (!ADMIN_USER_IDS.includes(senderId)) {
    await tgSend(chatId, '⛔ Команда доступна только менеджерам.', threadId, replyToId);
    return;
  }

  const usage = [
    '<b>Чёрный список:</b>',
    '<code>/blacklist add user_id 5571369741 причина</code>',
    '<code>/blacklist add phone +79991234567 причина</code>',
    '<code>/blacklist add usdt TQR... причина</code>',
    '<code>/blacklist add card 4276... причина</code>',
    '<code>/blacklist remove user_id 5571369741</code>',
    '<code>/blacklist list</code>',
  ].join('\n');

  const parts = String(args || '').trim().split(/\s+/);
  const subcmd = (parts[0] || '').toLowerCase();

  if (!subcmd || subcmd === 'help') {
    await tgSend(chatId, usage, threadId, replyToId);
    return;
  }

  if (subcmd === 'list') {
    const items = await listBlacklist();
    if (items.length === 0) {
      await tgSend(chatId, '<i>Чёрный список пуст.</i>', threadId, replyToId);
      return;
    }
    const lines = [`<b>⛔ Чёрный список (${items.length}):</b>`, ''];
    items.slice(0, 50).forEach((it, i) => {
      const date = it.created_at ? new Date(it.created_at).toISOString().substring(0, 10) : '';
      lines.push(
        `<b>${i + 1}.</b> <code>${escapeHtml(it.identifier_type)}</code> = <code>${escapeHtml(it.identifier_value)}</code>` +
        (it.reason ? ` · ${escapeHtml(it.reason)}` : '') +
        (date ? ` <i>(${date})</i>` : '')
      );
    });
    if (items.length > 50) lines.push(``, `<i>… показаны первые 50 из ${items.length}</i>`);
    await tgSend(chatId, lines.join('\n'), threadId, replyToId);
    return;
  }

  if (subcmd === 'add' || subcmd === 'remove') {
    const type = (parts[1] || '').toLowerCase();
    const value = parts[2];
    if (!type || !value) {
      await tgSend(chatId, '❌ Не хватает аргументов.\n\n' + usage, threadId, replyToId);
      return;
    }
    if (!['user_id', 'phone', 'usdt', 'card'].includes(type)) {
      await tgSend(chatId,
        `❌ Неверный тип <code>${escapeHtml(type)}</code>.\n` +
        `Допустимы: <code>user_id</code>, <code>phone</code>, <code>usdt</code>, <code>card</code>.`,
        threadId, replyToId);
      return;
    }

    if (subcmd === 'add') {
      const reason = parts.slice(3).join(' ');
      const result = await addToBlacklist({
        type, value, reason, addedBy: senderId,
      });
      // Сообщение об успешном добавлении (или ошибке)
      let header;
      if (result.ok) {
        console.warn(`[admin /blacklist add] by=${senderId} type=${type} value=${result.normalizedValue}`);
        header = `✅ Добавлено в чёрный список:\n` +
          `<code>${escapeHtml(type)}</code> = <code>${escapeHtml(result.normalizedValue)}</code>` +
          (reason ? `\nПричина: ${escapeHtml(reason)}` : '');
      } else {
        header = `❌ ${escapeHtml(result.error)}`;
      }
      // Доп. строка про PuzzleBot ban для user_id
      let puzzleLine = '';
      if (type === 'user_id' && result.puzzle) {
        puzzleLine = result.puzzle.ok
          ? `\n🤖 Заблокирован в PuzzleBot — бот перестанет реагировать.`
          : `\n⚠️ PuzzleBot ban не сработал: ${escapeHtml(result.puzzle.error)}`;
      }
      await tgSend(chatId, header + puzzleLine, threadId, replyToId);

      // Личные уведомления админам — для блока в их личных аккаунтах
      if (result.ok && type === 'user_id') {
        const targetId = result.normalizedValue;
        const profileLine = await buildProfileLine_(targetId);
        const dmText = [
          `⛔ <b>Новый юзер в чёрном списке</b>`,
          ``,
          `<b>ID:</b> <code>${targetId}</code>`,
          profileLine,
          reason ? `<b>Причина:</b> ${escapeHtml(reason)}` : null,
          ``,
          `<b>Заблокируй у себя в личном аккаунте:</b>`,
          `1. Открой профиль (см. ссылку выше)`,
          `2. В профиле юзера жми <b>Заблокировать</b>`,
        ].filter(Boolean).join('\n');
        for (const adminId of ADMIN_USER_IDS) {
          try {
            await tgSend(adminId, dmText);
          } catch(e) {
            console.warn(`[admin /blacklist add] DM to admin ${adminId} failed:`, e.message);
          }
        }
      }
      return;
    }

    if (subcmd === 'remove') {
      const result = await removeFromBlacklist({ type, value });
      let header;
      if (result.ok) {
        console.warn(`[admin /blacklist remove] by=${senderId} type=${type} value=${result.normalizedValue}`);
        header = `✅ Удалено из чёрного списка:\n` +
          `<code>${escapeHtml(type)}</code> = <code>${escapeHtml(result.normalizedValue)}</code>`;
      } else {
        header = `❌ ${escapeHtml(result.error)}`;
      }
      let puzzleLine = '';
      if (type === 'user_id' && result.puzzle) {
        puzzleLine = result.puzzle.ok
          ? `\n🤖 Разблокирован в PuzzleBot — бот снова реагирует.`
          : `\n⚠️ PuzzleBot unban не сработал: ${escapeHtml(result.puzzle.error)}`;
      }
      await tgSend(chatId, header + puzzleLine, threadId, replyToId);

      // Личное уведомление админам — напомнить разблокировать у себя
      if (result.ok && type === 'user_id') {
        const targetId = result.normalizedValue;
        const profileLine = await buildProfileLine_(targetId);
        const dmText = [
          `♻️ <b>Юзер удалён из чёрного списка</b>`,
          ``,
          `<b>ID:</b> <code>${targetId}</code>`,
          profileLine,
          ``,
          `Если ты раньше блокировал его у себя в личке — можешь разблокировать.`,
        ].join('\n');
        for (const adminId of ADMIN_USER_IDS) {
          try {
            await tgSend(adminId, dmText);
          } catch(e) {
            console.warn(`[admin /blacklist remove] DM to admin ${adminId} failed:`, e.message);
          }
        }
      }
      return;
    }
  }

  await tgSend(chatId, `❌ Неизвестная подкоманда <code>${escapeHtml(subcmd)}</code>.\n\n` + usage, threadId, replyToId);
}

async function handleHelpCommand(message) {
  const senderId = String(message.from.id);
  if (!ADMIN_USER_IDS.includes(senderId)) return;

  const helpText = [
    `<b>🔧 Команды админ-бота VietChange</b>`,
    ``,
    `<b>/check ID</b> — проверить клиента по Telegram ID`,
    `Пример: <code>/check 5571369741</code>`,
    ``,
    `<b>/check @username</b> — проверить по username (только если клиент в нашей БД)`,
    `Пример: <code>/check @SashaCashh</code>`,
    ``,
    `<b>⛔ Чёрный список</b>`,
    `<code>/blacklist add user_id 5571369741 причина</code>`,
    `<code>/blacklist add phone +79991234567 причина</code>`,
    `<code>/blacklist add usdt TQR... причина</code>`,
    `<code>/blacklist add card 4276... причина</code>`,
    `<code>/blacklist remove user_id 5571369741</code>`,
    `<code>/blacklist list</code>`,
    ``,
    `<b>/help</b> — показать это сообщение`,
    ``,
    `Результаты проверки приходят в топик <b>Risk Check</b>.`,
  ].join('\n');

  await tgSend(message.chat.id, helpText, message.message_thread_id, message.message_id);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  // ─── ПРОВЕРКА SECRET_TOKEN ──────────────────────────────────
  // Без правильного токена в заголовке любой может подменить update.
  // Если ADMIN_WEBHOOK_SECRET не задан — лог-предупреждение и 503,
  // чтобы случайно не оставить endpoint открытым в продакшене.
  if (!ADMIN_WEBHOOK_SECRET) {
    console.error('[admin-webhook] ADMIN_WEBHOOK_SECRET is not set — refusing request');
    return res.status(503).json({ ok: false, error: 'Webhook not configured' });
  }
  const headerToken = req.headers['x-telegram-bot-api-secret-token'];
  if (!headerToken || headerToken !== ADMIN_WEBHOOK_SECRET) {
    console.warn('[admin-webhook] forbidden — bad/absent secret_token header');
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  try {
    const update = req.body;
    if (!update) return res.status(200).json({ ok: true });

    const message = update.message || update.edited_message;
    if (!message || !message.text) return res.status(200).json({ ok: true });

    const text = message.text.trim();

    const match = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/);
    if (!match) return res.status(200).json({ ok: true });

    const command = match[1].toLowerCase();
    const args = match[2] || '';

    if (command === 'check') {
      await handleCheckCommand(message, args);
    } else if (command === 'blacklist') {
      await handleBlacklistCommand(message, args);
    } else if (command === 'help' || command === 'start') {
      await handleHelpCommand(message);
    }

    return res.status(200).json({ ok: true });

  } catch(e) {
    console.error('[admin-webhook] error:', e);
    // Не светим e.message Telegram'у (он попадёт в логи Telegram).
    return res.status(200).json({ ok: false });
  }
}

