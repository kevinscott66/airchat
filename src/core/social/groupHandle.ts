/**
 * Публичный адрес группы или канала — «@имя».
 *
 * Реестра у таких адресов НЕТ и по замыслу не будет: `claimSyncUsername`
 * привязывает имя к ключевой паре аккаунта, а у группы своей пары нет —
 * подписать заявку на имя ей нечем. Поэтому адрес группы это ЯРЛЫК: его
 * ставит администратор, он едет конвертом 'meta' вместе с названием и
 * описанием, и два разных канала в разных углах сети вполне могут выбрать
 * одну и ту же строку.
 *
 * Из этого следуют два правила, которые нельзя нарушать:
 *
 * 1. Опознаётся группа по неизменяемому публичному идентификатору
 *    (`publicIdFor('group' | 'channel', id)` — GR…/CH…), а не по адресу.
 *    Показывая адрес, рядом всегда показывают и идентификатор.
 * 2. Адрес группы НЕ должен разрешаться там, где ищут аккаунт по @имени
 *    (mentionLookup): иначе канал, назвавшийся @support, перехватывал бы
 *    упоминания живого человека.
 *
 * Правила самого имени не пишутся здесь заново: их источник —
 * `checkUsernameClaim` (набор символов, «только цифры», длина, занятые
 * системой слова). Так группа не сможет взять @official или @news.
 *
 * v4.32.936: и на ВХОДЕ тоже. До этой версии конверт с чужого устройства
 * проходил здесь только через `normalizeUsername` — послабление, списанное с
 * аккаунтов, где короткое имя бывает выдано бумагой. У группы бумаги нет и
 * быть не может: её адрес ставит рукой администратор, и другого пути у строки
 * нет. Послабление означало ровно одно — изменённый клиент ставил своей группе
 * адрес `@support` в обход списка, а чужие приложения его показывали. Правило
 * теперь одно для своего поля ввода и для входящего конверта.
 */
import { checkUsernameClaim, type UsernameRejection } from '../identity/reservedUsernames';
import { normalizeUsername } from '../identity/username';

/** Группа или канал: от вида зависит только текст отказа. */
export type GroupHandleKind = 'group' | 'channel';

export type GroupHandleCheck =
  | { ok: true; handle: string }
  | { ok: false; reason: UsernameRejection; text: string };

/**
 * Чем кончился разбор адреса из входящего конверта.
 *
 * Две причины отказа разведены намеренно, потому что поступать с ними надо
 * по-разному. `malformed` — это вообще не адрес (пробелы, кириллица, мусор):
 * такой конверт собран не нашим кодом, доверия ему нет, и он отбрасывается
 * целиком. `refused` — форма верная, но такой адрес занять нельзя (`@support`,
 * `@nft`, три буквы): остальные поля конверта — название, описание — при этом
 * законны и отправитель вправе их менять, поэтому выбрасывается одно поле.
 */
export type GroupHandleParse =
  | { kind: 'ok'; handle: string }
  | { kind: 'refused' }
  | { kind: 'malformed' };

/**
 * Разбор адреса из конверта 'meta' с чужого устройства. Пустая строка сюда не
 * передаётся: она означает «адрес убрали» и обрабатывается отдельно.
 */
export function parseGroupHandleFromEnvelope(value: unknown): GroupHandleParse {
  const normalized = normalizeUsername(value);
  if (normalized == null) return { kind: 'malformed' };
  // Без `unlocked`: бумаги у группы нет — см. заголовок файла.
  const claim = checkUsernameClaim(normalized);
  if (!claim.ok) return { kind: 'refused' };
  return { kind: 'ok', handle: claim.username };
}

/** «alpha» → «@alpha». Единственное место, где приклеивается собачка. */
export function formatGroupHandle(handle: string): string {
  return `@${handle}`;
}

function rejectionText(reason: UsernameRejection, kind: GroupHandleKind): string {
  const what = kind === 'channel' ? 'канала' : 'группы';
  switch (reason) {
    case 'empty':
      return `Введите публичный адрес ${what}.`;
    case 'charset':
      return 'Только латинские буквы, цифры и подчёркивание.';
    case 'digits_only':
      return 'Адрес не может состоять из одних цифр.';
    case 'too_short':
      return 'Слишком короткий адрес.';
    case 'too_long':
      return 'Слишком длинный адрес.';
    case 'reserved':
      return 'Этот адрес занят.';
  }
}

/**
 * Проверка адреса, который вводит администратор. Возвращает либо канонический
 * адрес, либо причину и уже готовый текст для показа.
 */
export function checkGroupHandle(value: unknown, kind: GroupHandleKind): GroupHandleCheck {
  const claim = checkUsernameClaim(value);
  if (claim.ok) return { ok: true, handle: claim.username };
  return { ok: false, reason: claim.reason, text: rejectionText(claim.reason, kind) };
}
