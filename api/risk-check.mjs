// /api/risk-check.mjs
// VietChange — модуль риск-проверки клиента перед отправкой заявки менеджеру.
// Запросы к CAS, LolsBot + эвристики (возраст, username, сумма).
// Точная дата регистрации через линейную интерполяцию.

// === Контрольные точки user_id → дата регистрации ===
// Telegram выдаёт ID примерно последовательно по времени.
// Между точками используется линейная интерполяция.
// Точность: ±2-4 недели.
const REGISTRATION_CHECKPOINTS = [
  { id: 1000000,    date: new Date('2013-08-01') },
  { id: 10000000,   date: new Date('2014-06-01') },
  { id: 100000000,  date: new Date('2016-01-01') },
  { id: 200000000,  date: new Date('2017-04-01') },
  { id: 400000000,  date: new Date('2018-04-01') },
  { id: 800000000,  date: new Date('2019-09-01') },
  { id: 1000000000, date: new Date('2020-02-01') },
  { id: 1500000000, date: new Date('2021-03-01') },
  { id: 2000000000, date: new Date('2022-01-01') },
  { id: 5000000000, date: new Date('2022-09-01') },
  { id: 5500000000, date: new Date('2022-12-01') },
  { id: 6000000000, date: new Date('2023-04-01') },
  { id: 6500000000, date: new Date('2023-10-01') },
  { id: 7000000000, date: new Date('2024-03-01') },
  { id: 7500000000, date: new Date('2024-09-01') },
  { id: 8000000000, date: new Date('2025-03-01') },
  { id: 8500000000, date: new Date('2025-09-01') },
  { id: 9000000000, date: new Date('2026-03-01') },
];

const API_TIMEOUT_MS = 3000;

/**
 * Оценка даты регистрации по user_id (линейная интерполяция между точками).
 */
function estimateRegistration(userId) {
  const id = Number(userId);
  if (!id || isNaN(id)) {
    return { regDate: null, ageDays: null };
  }
  
  const cps = REGISTRATION_CHECKPOINTS;
  let regDate;
  
  if (id <= cps[0].id) {
    regDate = cps[0].date;
  } else if (id >= cps[cps.length - 1].id) {
    regDate = cps[cps.length - 1].date;
  } else {
    for (let i = 0; i < cps.length - 1; i++) {
      if (id >= cps[i].id && id <= cps[i + 1].id) {
        const ratio = (id - cps[i].id) / (cps[i + 1].id - cps[i].id);
        const t1 = cps[i].date.getTime();
        const t2 = cps[i + 1].date.getTime();
        regDate = new Date(t1 + ratio * (t2 - t1));
        break;
      }
    }
  }
  
  const ageDays = Math.floor((Date.now() - regDate.getTime()) / 86400000);
  return { regDate, ageDays };
}

/**
 * Проверка через CAS (Combot Anti-Spam). Бесплатно, без ключа.
 * Возвращает { listed: true|false|null, error }
 *  - listed: true  → найден в базе спамеров
 *  - listed: false → чистый
 *  - listed: null  → проверка не удалась (чтобы не считать «чистым» по ошибке)
 */
async function checkCas(userId) {
  if (!userId) return { listed: null, error: 'no userId' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    const res = await fetch(
      `https://api.cas.chat/check?user_id=${userId}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return { listed: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data.ok === true && data.result) {
      return { 
        listed: true, 
        offenses: data.result.offenses || 0,
      };
    }
    return { listed: false };
  } catch (e) {
    return { listed: null, error: e.message || 'fetch error' };
  }
}

/**
 * Проверка через LolsBot API.
 * Схема endpoint не задокументирована публично — пробуем разные поля.
 * Возвращает { banned: true|false|null, error }
 */
async function checkLolsBot(userId) {
  if (!userId) return { banned: null, error: 'no userId' };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    const res = await fetch(
      `https://api.lols.bot/account?id=${userId}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return { banned: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    const banned = 
      data.banned === true || 
      data.is_banned === true ||
      data.scammer === true || 
      data.is_scammer === true ||
      data.lols_ban === true ||
      data.ok === true;
    return { 
      banned, 
      spam_factor: data.spam_factor || null,
      raw: data,
    };
  } catch (e) {
    return { banned: null, error: e.message || 'fetch error' };
  }
}

/**
 * Главная функция — оценка риска.
 * @param {string|number} userId
 * @param {object} opts — { username, rubEquiv }
 */
export async function assessRisk(userId, opts = {}) {
  const { username, rubEquiv = 0 } = opts;
  
  // Параллельные запросы к API
  const [cas, lols] = await Promise.all([
    checkCas(userId),
    checkLolsBot(userId),
  ]);
  
  // Возраст
  const reg = estimateRegistration(userId);
  const ageDays = reg.ageDays;
  
  // Форматирование возраста
  let ageStr = 'неизвестно';
  if (ageDays !== null) {
    if (ageDays < 30) {
      ageStr = `${ageDays} дн`;
    } else if (ageDays < 365) {
      const m = Math.floor(ageDays / 30);
      ageStr = `${m} мес`;
    } else {
      const y = (ageDays / 365).toFixed(1);
      ageStr = `${y} года`;
    }
  }
  
  // Username — учитываем отсутствие как сигнал
  const hasUsername = username && 
    typeof username === 'string' && 
    username.length > 0 && 
    username !== '—' &&
    username !== '@';
  
  const flags = [];
  let level = 'LOW';
  
  // 1. CAS
  if (cas.listed === true) {
    const offText = cas.offenses ? ` (${cas.offenses} нарушений)` : '';
    flags.push(`CAS: 🚩 В базе спамеров${offText}`);
    level = 'HIGH';
  } else if (cas.listed === false) {
    flags.push(`CAS: ✅ чисто`);
  } else {
    flags.push(`CAS: ⚙️ не проверено`);
  }
  
  // 2. LolsBot
  if (lols.banned === true) {
    flags.push(`LolsBot: 🚩 Скам/спам-аккаунт`);
    level = 'HIGH';
  } else if (lols.banned === false) {
    flags.push(`LolsBot: ✅ чисто`);
  } else {
    flags.push(`LolsBot: ⚙️ не проверено`);
  }
  
  // 3. Возраст
  if (ageDays !== null) {
    if (ageDays < 30) {
      flags.push(`Возраст: ⚠️ ${ageStr} (новый)`);
      if (level === 'LOW') level = 'MEDIUM';
    } else if (ageDays < 90) {
      flags.push(`Возраст: ⚠️ ${ageStr}`);
      if (level === 'LOW') level = 'MEDIUM';
    } else {
      flags.push(`Возраст: ✅ ${ageStr}`);
    }
  }
  
  // 4. Username
  if (!hasUsername) {
    flags.push(`Username: ⚠️ нет`);
    if (level === 'LOW') level = 'MEDIUM';
  } else {
    flags.push(`Username: ✅ есть`);
  }
  
  // 5. Крупная сумма + молодой аккаунт
  if (ageDays !== null && rubEquiv >= 100000 && ageDays < 30) {
    flags.push(`💰 Крупная сумма + новый аккаунт`);
    level = 'HIGH';
  } else if (ageDays !== null && rubEquiv >= 200000 && ageDays < 90) {
    flags.push(`💰 Крупная сумма + молодой аккаунт`);
    if (level === 'LOW') level = 'MEDIUM';
  }
  
  const emoji = level === 'HIGH' ? '🔴' : level === 'MEDIUM' ? '🟡' : '🟢';
  const summary = level === 'HIGH' ? 'ВЫСОКИЙ' : level === 'MEDIUM' ? 'СРЕДНИЙ' : 'НИЗКИЙ';
  
  return {
    level,
    emoji,
    summary,
    flags,
    ageDays,
    casChecked: cas.listed !== null,
    lolsChecked: lols.banned !== null,
  };
}

/**
 * Форматирование блока для сообщения в группу менеджеров.
 */
export function formatRiskBlock(risk) {
  const lines = [
    ``,
    `🛡 <b>Риск-проверка: ${risk.emoji} ${risk.summary}</b>`,
    ...risk.flags.map(f => `├ ${f}`),
  ];
  // Последняя строка — переделываем ├ на └
  lines[lines.length - 1] = lines[lines.length - 1].replace('├', '└');
  return lines.join('\n');
}

/**
 * Короткая строка для основной заявки (одна строка с итогом).
 */
export function formatRiskShort(risk) {
  return `🛡 <b>Риск-проверка: ${risk.emoji} ${risk.summary}</b>`;
}
