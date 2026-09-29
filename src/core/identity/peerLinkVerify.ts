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
 * Ответ запоминается вместе с адресом И ИМЕНЕМ. Не ради скорости:
 * подтверждение — это факт «в такой-то день по такому-то адресу лежала
 * подписанная строка ТАКОГО-ТО имени», и он относится к этой паре целиком.
 * Прислали другую — прежний ответ о ней ничего не говорит, и галочка гаснет
 * до новой проверки.
 *
 * v4.32.638: имени в записи не было, сверялся один адрес. Проверить настоящую
 * свою публикацию, а потом прислать тот же адрес под чужим именем, стоило
 * ровно одного конверта профиля: галочка загоралась, в карточке писалось
 * «публикация по указанному адресу принадлежит @имя», а кнопка «Проверить
 * привязку» показывается только непроверенным — переспросить было нельзя.
 * Выходило хуже, чем до v4.32.573: тогда чужое имя было просто словами, а
 * стало словами с зелёной галочкой.
 */
import { scopedKvSet, scopedKvTryGet } from '../storage/profileScopedKv';
import { checkLinkProof } from './linkProofCheck';
import { encodeLinkProofRecord, readLinkProofRecord, sameHandle, type ProofFailure } from './linkProof';
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
 * Ответ действителен только для той пары «адрес + имя», по которой его
 * получили, — обе половины передаются и сверяются. Запись без имени (сделана
 * до v4.32.638) подтверждением не считается: чьё имя тогда сошлось, из неё
 * не узнать, а гадать тут нельзя. Человек нажмёт «Проверить привязку» ещё
 * раз, и запись станет полной.
 */
export async function peerLinkVerifiedAt(
  peerPubB64: string,
  link: ProfileLink
): Promise<number | null> {
  return (await peerLinkVerifiedAtTry(peerPubB64, link))?.at ?? null;
}

/**
 * То же исходом чтения (v4.32.1041).
 *
 * `{ at }` — запись прочитали: внутри либо дата ответа, либо `null`, то есть
 * «этой пары мы не проверяли». `null` — прочитать не смогли.
 *
 * Разница здесь не про галочку. Кнопка «Проверить привязку» показывается
 * ровно непроверенным, а нажатие на неё уходит на github.com или x.com с IP
 * человека — тем самым запросом, которого весь этот модуль и избегает делать
 * сам. Пока оба ответа были одним `null`, занятый SQLite превращался в
 * предложение сходить на площадку и в строчку «Пока вы её не проверили» — то
 * есть в утверждение о том, чего мы не знаем, и в повод нажать. Отказ базы не
 * должен уговаривать человека рассказать двум чужим площадкам, чей профиль он
 * сейчас открыл.
 */
export async function peerLinkVerifiedAtTry(
  peerPubB64: string,
  link: ProfileLink
): Promise<{ at: number | null } | null> {
  // Адреса публикации нет вовсе — это полноценный ответ, и база тут не нужна.
  if (!link.u) return { at: null };
  const read = await scopedKvTryGet(key(peerPubB64, link.p));
  if (read === null) {
    log.warn('peer_link_state_unreadable', { platform: link.p });
    return null;
  }
  const rec = readLinkProofRecord(read.value);
  if (!rec || rec.url !== link.u) return { at: null };
  if (!rec.h || !sameHandle(rec.h, link.h)) return { at: null };
  return { at: rec.verifiedAt };
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
    await scopedKvSet(
      key(peerPubB64, link.p),
      encodeLinkProofRecord({ url: link.u, verifiedAt, h: link.h })
    );
  } catch (e) {
    // Ответ уже получен: не записался — просто спросим ещё раз в другой день.
    log.warn('peer_link_store_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return { ok: true, verifiedAt };
}
