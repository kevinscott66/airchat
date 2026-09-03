/**
 * peerLinkVerify — проверка чужой привязки на СВОЁМ устройстве (v4.32.575).
 *
 * Собеседник присылает в конверте профиля имя учётной записи и адрес
 * публикации (identity/profileLinks). Он не присылает — и не может прислать —
 * ответ на вопрос «правда ли это его учётная запись»: любой присланный ответ
 * означал бы только то, что отправитель его написал. Ответ получает тот, кому
 * он нужен, своей же сетью: читает публикацию по адресу, смотрит, кто её
 * автор, и проверяет подпись под строкой внутри ключом того самого аккаунта,
 * от которого приехал конверт. Ровно та же проверка, что человек делает себе
 * при привязке, — она и лежит в linkProofCheck, здесь только своя половина:
 * чей ключ ожидать и где запомнить ответ.
 *
 * Запрос уходит ТОЛЬКО по нажатию, как и при своей привязке. Делать его при
 * открытии карточки нельзя: карточка открывается тапом по имени в чате, в
 * ленте, в комментариях, — и приложение ходило бы в GitHub и X с IP человека
 * каждый раз, когда он на кого-то нажал. Это не мелочь: так внешние площадки
 * узнают, кого и когда он смотрит.
 *
 * Ответ запоминается вместе с адресом. Не ради скорости: подтверждение — это
 * факт «в такой-то день по такому-то адресу лежала подписанная строка», и он
 * относится к КОНКРЕТНОМУ адресу. Прислали другой — прежний ответ ничего о
 * нём не говорит, и галочка гаснет до новой проверки.
 */
import { scopedKvGet, scopedKvSet } from '../storage/profileScopedKv';
import { checkLinkProof } from './linkProofCheck';
import { encodeLinkProofRecord, readLinkProofRecord, type ProofFailure } from './linkProof';
import type { ProfileLink } from './profileLinks';
import { log } from '../logger';

/**
 * Ключ ответа. Открытый ключ собеседника входит в него целиком: одна и та же
 * учётная запись на площадке может быть заявлена разными аккаунтами AirChat, и
 * проверка одного из них не отвечает ни за кого другого.
 */
function key(peerPubB64: string, platform: ProfileLink['p']): string {
  return `peer_link:${platform}:${peerPubB64}`;
}

/**
 * Что уже проверено на этом устройстве: дата ответа или null.
 *
 * Ответ действителен только для того адреса, по которому его получили, —
 * поэтому адрес передаётся и сверяется.
 */
export async function peerLinkVerifiedAt(
  peerPubB64: string,
  link: ProfileLink
): Promise<number | null> {
  if (!link.u) return null;
  const rec = readLinkProofRecord(await scopedKvGet(key(peerPubB64, link.p)));
  return rec && rec.url === link.u ? rec.verifiedAt : null;
}

export type PeerLinkResult = { ok: true; verifiedAt: number } | { ok: false; reason: ProofFailure };

/**
 * Сходить к площадке и запомнить ответ.
 *
 * Отрицательный ответ не запоминается намеренно. «Не сошлось» — это чаще
 * всего «площадка не ответила» или «публикацию только что завели»; запись
 * такого ответа в базу означала бы, что человеку показывают вчерашнюю неудачу
 * как сегодняшний факт.
 */
export async function verifyPeerLink(
  peerPubB64: string,
  link: ProfileLink
): Promise<PeerLinkResult> {
  if (!link.u) return { ok: false, reason: 'no_token' };
  const res = await checkLinkProof(link.u, {
    platform: link.p,
    handle: link.h,
    publicKeyB64: peerPubB64,
  });
  if (!res.ok) {
    log.info('peer_link_check_failed', { p: link.p, reason: res.reason });
    return { ok: false, reason: res.reason };
  }
  const verifiedAt = Date.now();
  try {
    await scopedKvSet(key(peerPubB64, link.p), encodeLinkProofRecord({ url: link.u, verifiedAt }));
  } catch (e) {
    // Ответ уже получен: не записался — просто спросим ещё раз в другой день.
    log.warn('peer_link_store_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return { ok: true, verifiedAt };
}
