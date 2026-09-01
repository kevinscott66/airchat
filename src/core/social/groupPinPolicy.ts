/**
 * Кто может закреплять сообщения в группе.
 *
 * Модуль намеренно без импортов: одна и та же функция решает и на отправке
 * (показывать ли пункт «Закрепить»), и на приёме чужого '\x0egctl:' pin.
 * Если бы правило жило только в экране, любой участник мог бы прислать
 * закрепление в обход UI — а разойтись эти две проверки не должны в принципе.
 *
 * Совместимо по типам с MemberRole/GroupType из storage/local, но не тянет их
 * импортом: messaging-цепочка подтягивает весь IPFS-стек и не собирается под
 * jest (см. groupControlEnvelope.ts).
 */

export type PinRole = 'owner' | 'admin' | 'member' | 'restricted' | 'banned';
export type PinGroupType = 'group' | 'channel' | 'supergroup';

export type PinPolicyInput = {
  role: PinRole;
  /** Настройка группы: закреплять могут только администраторы. */
  adminOnlyPinning: boolean;
  type?: PinGroupType;
};

/**
 * `adminOnlyPinning` — настройка группы, роль — право участника. Настройка
 * может только расширить круг до обычных участников; забанённого,
 * ограниченного и подписчика канала она не касается.
 */
export function canPinInGroup({ role, adminOnlyPinning, type = 'group' }: PinPolicyInput): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'banned') return false;
  // В канале пишут только администраторы — закрепление подписчиком было бы
  // единственным способом что-то показать всей аудитории.
  if (type === 'channel') return false;
  // Ограниченному участнику запрещена отправка; закрепление — тот же баннер
  // всем, только заметнее.
  if (role === 'restricted') return false;
  return !adminOnlyPinning;
}
