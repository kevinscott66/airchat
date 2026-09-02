/**
 * verificationGrant — форма бумаги на галочку, без криптографии (v4.32.547).
 *
 * Отдельным файлом от `verification` намеренно. Бумага едет внутри конверта
 * профиля, а конверт разбирается модулем, который специально не тянет за собой
 * ни подписи, ни журнал, ни базу: разбор недоверенного ввода должен читаться и
 * проверяться сам по себе (см. profileEnvelope). Если бы предел длины и форма
 * лежали рядом с проверкой подписи, конверту пришлось бы импортировать всю
 * криптографию ради одного числа — либо, что хуже, завести своё второе число.
 *
 * Здесь только «похоже ли это вообще на бумагу». Настоящая ли подпись, кому
 * бумага выдана и на какое имя — вопросы к `verification`.
 */

/**
 * Вид галочки. Пока один — «официальный аккаунт приложения». Отдельным типом,
 * а не булевым полем: «подтверждённый бизнес» и «государственная организация»
 * это другие обещания, и когда они появятся, они не должны выглядеть одинаково.
 */
export type VerifiedBadge = 'official';

/** Подписанная бумага в том виде, в каком её отдаёт `signJson`. */
export type VerificationGrant = { payload: string; signature: string };

/**
 * Потолок на строку бумаги. Настоящая — около трёхсот байт: did:key (56),
 * имя (до 32), подпись base64 (88) и обвязка JSON. Запас четырёхкратный, но
 * конечный: бумага едет в конверте профиля, а конверт целиком ограничен
 * восемью килобайтами, и без своего предела одна галочка вытеснила бы оттуда
 * имя и «О себе».
 */
export const MAX_GRANT_LEN = 1024;

/** Строка → бумага. Ничего не проверяет, кроме формы. */
export function decodeGrant(value: unknown): VerificationGrant | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_GRANT_LEN) return null;
  try {
    const g = JSON.parse(s) as Partial<VerificationGrant>;
    if (!g || typeof g !== 'object') return null;
    if (typeof g.payload !== 'string' || typeof g.signature !== 'string') return null;
    return { payload: g.payload, signature: g.signature };
  } catch {
    return null;
  }
}

/** Бумага → строка для хранения и пересылки. */
export function encodeGrant(grant: VerificationGrant): string {
  return JSON.stringify({ payload: grant.payload, signature: grant.signature });
}
