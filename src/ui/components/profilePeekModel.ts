/**
 * Что показывает карточка профиля (v4.32.363).
 *
 * Вынесено из UserProfilePeek: сама карточка — @stable, а решения в ней
 * («как зовут», «в контактах ли», «под каким именем добавлять») до сих пор
 * жили внутри JSX и не проверялись ничем. Тут нет React и нет платформенных
 * модулей — только правила.
 */

import { publicKeyToDidKey, parseDidKey } from '../../core/identity/did';
import { publicKeyFromB64, publicKeyToB64 } from '../../core/crypto/pubKeyFormat';
import { nameInitials } from '../../core/social/contactLabel';
import { shortIdentity } from '../identity/shortId';

export type PeekPeer = { pubB64: string; did: string };

/**
 * Нормализует pubB64 / did в пару {pubB64, did}. Возвращает null, если ни одна
 * форма не пригодна. Ни одна ветка не бросает: Buffer.from на негодной base64
 * молча выбрасывает лишние символы, а parseDidKey отдаёт null, — поэтому годность
 * решает проверка длины и алфавита, а не отсутствие исключения.
 */
export function resolvePeer(
  pubB64?: string | null,
  did?: string | null
): PeekPeer | null {
  // v4.32.427: try/catch отсюда убраны — ни одна из двух веток бросить не
  // может. Buffer.from на негодной base64 не бросает, parseDidKey отдаёт null.
  // Оба catch были мёртвыми, а комментарий над ними обещал защиту от
  // исключений, которых не бывает.
  if (pubB64) {
    const raw = publicKeyFromB64(pubB64);
    if (raw) return { pubB64, did: publicKeyToDidKey(raw) };
  }
  if (did) {
    // Длина после parseDidKey не проверяется: парсер отдаёт ровно 32 байта.
    const raw = parseDidKey(did);
    if (raw) return { pubB64: publicKeyToB64(raw), did };
  }
  return null;
}

/** did:key:z6Mk…xYz → z6Mk…xYz, середина вырезана. */
export function shortDid(did: string, keep = 8): string {
  return shortIdentity(did, keep);
}

export type PeekContact = {
  displayName: string;
  /** Контакт заведён автоматически при переписке, а не добавлен человеком. */
  implicit?: boolean;
};

export type PeekIdentity = {
  /** Заголовок карточки. */
  title: string;
  /** Имя, под которым пойдёт «Добавить в контакты» и открытие чата. */
  contactName: string;
  /** Имя настоящее (наше или его собственное), а не заглушка из DID. */
  named: boolean;
  /** Буквы на аватаре. */
  initials: string;
  /** Добавлен в адресную книгу руками. Implicit-строка этим не считается. */
  inContacts: boolean;
  /** Подпись под именем. */
  hint: string;
};

/**
 * Кто перед нами и что об этом написать.
 *
 * Два правила, из-за которых это вообще отдельная функция:
 *
 * 1. Implicit-контакт — не контакт. Строка создаётся сама при первой переписке
 *    с незнакомцем (ensureImplicitContact) и в «Контактах» не показывается.
 *    Карточка же считала контактом любую найденную строку: писала «В ваших
 *    контактах» про незнакомца и прятала «Добавить в контакты» — то есть
 *    единственный способ добавить написавшего вам человека был недоступен
 *    ровно там, где он нужен.
 *
 * 2. Безымянному нельзя давать имя «Контакт». Ни одно место вызова не передаёт
 *    fallbackName, а у implicit-строки displayName пустой, — и заголовком
 *    служило слово «Контакт». Оно же уходило в addContact: двое добавленных
 *    незнакомцев становились двумя одинаковыми «Контактами» в списке чатов.
 *    Заглушка из DID хотя бы различает людей и явно выглядит как ID.
 */
export function peekIdentity(input: {
  contact: PeekContact | null;
  fallbackName?: string | null;
  did: string;
  isSelf: boolean;
}): PeekIdentity {
  const { contact, fallbackName, did, isSelf } = input;
  const name = (contact?.displayName || '').trim() || (fallbackName || '').trim();
  const named = name.length > 0;
  const inContacts = !!contact && contact.implicit !== true;
  const hint = isSelf
    ? 'Это ваш профиль'
    : inContacts
      ? 'В ваших контактах'
      : contact
        ? 'Не в контактах — вы переписывались'
        : 'Не в контактах';
  return {
    // В шапке — «Без имени»: DID и так показан строкой ниже, дважды один и тот
    // же набор знаков читается как ошибка. А вот в адресную книгу такой человек
    // уходит именно с DID-заглушкой — там ему жить рядом с другими.
    title: named ? name : 'Без имени',
    contactName: named ? name : shortDid(did, 6),
    named,
    // У did:key все ключи Ed25519 начинаются одинаково, так что инициал из
    // заглушки был бы «Z» у каждого встречного.
    initials: named ? nameInitials(name) : '?',
    inContacts,
    hint,
  };
}
