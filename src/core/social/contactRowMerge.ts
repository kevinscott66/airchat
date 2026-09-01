/**
 * contactRowMerge — как ложится строка контакта, когда его добавляют явно.
 *
 * v4.32.570. Строка контакта хранит не только имя и общий ключ. С v4.32.247
 * в неё же кладётся профиль собеседника, пришедший конвертом '\x14':
 * `peerName`, `peerUsername`, `bio`, `avatarCid` и время этого профиля
 * `profileTs`. Отсюда берутся имя и фотография в списке чатов, в шапке
 * переписки и в карточке контакта.
 *
 * `addContact` собирала строку заново из литерала с четырьмя полями —
 * `displayName`, `symKey`, `implicit`, `profileCid` — и всё остальное
 * исчезало. Достаточно было добавить в контакты того, с кем уже переписка:
 * по QR-коду, по ссылке, кнопкой из карточки. Человек нажимал «добавить» и
 * терял и имя собеседника, и его фотографию — контакт превращался в кружок с
 * буквой. Само по себе это не чинится: профиль присылают, когда его меняют, и
 * до следующего раза может пройти сколько угодно.
 *
 * Соседние функции так не делают: `setPeerProfileFor` и `renameContact`
 * пишут `{ ...j, ...next }` и незнакомые поля сохраняют. Литерал в
 * `addContact` был единственным местом, где строка собиралась с нуля.
 *
 * Правило: явное добавление меняет ровно то, ради чего его позвали, —
 * отметку «контакт добавлен вручную», общий ключ и имя, — и не трогает
 * ничего, о чём не знает.
 *
 * Модуль без импортов: слияние проверяется отдельно от базы, ECDH и профилей.
 */

export type ContactRowPatch = {
  /** Имя, уже прошедшее чистку. Пустое — оставить прежнее. */
  displayName: string;
  /** Общий ключ в base64: он выводится заново при каждом добавлении. */
  symKeyB64: string;
  /** Ссылка на карточку профиля. Пустая или отсутствующая — оставить прежнюю. */
  profileCid?: string;
};

function readObject(raw: string | null | undefined): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    // Испорченная строка — не повод потерять контакт: он пересоберётся из
    // заплатки, как и до этой версии.
    return {};
  }
}

function readString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Строка контакта после явного добавления: прежние поля целы, отметка
 * `implicit` снята.
 */
export function mergeExplicitContactRow(
  prevRaw: string | null | undefined,
  patch: ContactRowPatch
): string {
  const prev = readObject(prevRaw);
  const displayName = patch.displayName || readString(prev, 'displayName');
  const profileCid = patch.profileCid || readString(prev, 'profileCid');
  const next: Record<string, unknown> = {
    ...prev,
    displayName,
    symKey: patch.symKeyB64,
    implicit: false,
  };
  // Пустую ссылку на карточку не пишем вовсе — так было и раньше, и по её
  // отсутствию отличают «карточки нет» от «карточка пустая».
  if (profileCid) next.profileCid = profileCid;
  else delete next.profileCid;
  return JSON.stringify(next);
}
