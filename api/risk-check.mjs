// /api/risk-check.mjs
// Проверка клиента на риск (скам/спам)
// Используется в /api/order.js перед отправкой заявки в группу менеджеров

// === Контрольные точки user_id → дата регистрации ===
// Telegram выдаёт ID примерно последовательно по времени.
// Между точками используется линейная интерполяция.
// Точность: ±2-4 недели. Этого достаточно для оценки риска.
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

/**
 * Оценка даты регистрации по user_id (линейная интерполяция между точками).
 */
function estimateRegistration(userId) {
  const id = Number(userId);
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
 */
async function checkCas(userId) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);

    const res = await fetch(
      `https://api.cas.chat/check?user_id=${userId}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) return { banned: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    // ok:true → найден в базе спамеров; ok:false → чистый
    return { banned: data.ok === true };
  } catch (e) {
    return { banned: false, error: e.message };
  }
}

/**
 * Проверка через LolsBot API.
 * ВНИМАНИЕ: схема endpoint не задокументирована публично.
 * Если упадёт — проверка просто пропустится (graceful failure).
 */
async function checkLolsBot(userId) {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 3000);

    const res = await fetch(
      `https://api.lols.bot/account?id=${userId}`,
      { signal: ctrl.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) return { banned: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const banned = data.banned === true || data.scammer === true || data.ok === true;
    return { banned, raw: data };
  } catch (e) {
    return { banned: false, error: e.message };
  }
}

/**
 * Главная функция — оценка риска.
 */
export async function assessRisk(userId, rubEquiv = 0) {
  const [cas, lols] = await Promise.all([
    checkCas(userId),
    checkLolsBot(userId),
  ]);

  const reg = estimateRegistration(userId);
  const ageDays = reg.ageDays;
  const ageYears = (ageDays / 365).toFixed(1);

  let ageStr;
  if (ageDays < 30) ageStr = `${ageDays} дн`;
  else if (ageDays < 365) ageStr = `${Math.floor(ageDays / 30)} мес`;
  else ageStr = `${ageYears} года`;

  const flags = [];
  let level = 'LOW';

  if (cas.banned) {
    flags.push('CAS: ⚠️ В базе спамеров');
    level = 'HIGH';
  } else {
    flags.push(cas.error ? `CAS: ⚙️ недоступен` : `CAS: ✅ чисто`);
  }

  if (lols.banned) {
    flags.push('LolsBot: ⚠️ Скам-аккаунт');
    level = 'HIGH';
  } else {
    flags.push(lols.error ? `LolsBot: ⚙️ недоступен` : `LolsBot: ✅ чисто`);
  }

  if (ageDays < 30) {
    flags.push(`Возраст: ⚠️ ${ageStr} (новый)`);
    if (level === 'LOW') level = 'MEDIUM';
  } else if (ageDays < 90) {
    flags.push(`Возраст: ⚠️ ${ageStr}`);
    if (level === 'LOW') level = 'MEDIUM';
  } else {
    flags.push(`Возраст: ✅ ${ageStr}`);
  }

  if (ageDays < 30 && rubEquiv >= 100000) {
    level = 'HIGH';
    flags.push(`💰 Крупная сумма + новый аккаунт`);
  }

  const emoji = level === 'HIGH' ? '🔴' : level === 'MEDIUM' ? '🟡' : '🟢';
  const summary = level === 'HIGH' ? 'ВЫСОКИЙ' : level === 'MEDIUM' ? 'СРЕДНИЙ' : 'НИЗКИЙ';

  return {
    level,
    emoji,
    summary,
    flags,
    ageDays,
    casChecked: !cas.error,
    lolsChecked: !lols.error,
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
  lines[lines.length - 1] = lines[lines.length - 1].replace('├', '└');
  return lines.join('\n');
}
