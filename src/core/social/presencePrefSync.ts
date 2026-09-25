/**
 * Доставка настройки «кто видит моё время последнего входа».
 *
 * v4.32.238. «Был(а) в сети» в этом приложении считает ПОЛУЧАТЕЛЬ: каждое
 * входящее сообщение обновляет отметку у него (recordPeerActivity). Никакого
 * сервера, который мог бы скрыть эту отметку, нет — значит единственный
 * рабочий способ выполнить настройку — попросить собеседника не отмечать нас,
 * и это должно быть сказано прямо. Раньше не отправлялось ничего вообще, а
 * единственная проверка стояла в публикации через IPFS pubsub, который на
 * телефонах выключен.
 *
 * Кому что отправлять, решает presencePolicy.ts: «Контакты» здесь превращается
 * в «да» для контактов и «нет» для остальных, потому что только у отправителя
 * есть адресная книга.
 *
 * Честная граница: изменённый клиент может проигнорировать просьбу. Поэтому
 * рядом работает вторая половина, которую никто снаружи не отменит, —
 * взаимность в presenceService (скрыл своё время — не видишь чужое).
 */
import { scopedKvSetSecretCheckedFor, scopedKvTryGetSecretFor } from '../storage/profileScopedKv';
import { listContactsFor } from './contacts';
import { profileManager } from '../identity/profileManager';
import { mergeSentMap, parseSentMap, isSentFlag, trimSentMap } from './sentMap';
import { getMessagingService } from './messaging';
import {
  setPeerLastSeenAllowedFor,
  setMyLastSeenVisibility,
  effectiveMyLastSeenVisibility,
  presenceOwnerPid,
} from './presenceService';
import { shouldShareLastSeenWith, parseLastSeenVisibility, type LastSeenVisibility } from './presencePolicy';
import { privacyPrefTryGetFor } from '../settings/privacyPrefs';
import { canReachPeer } from './sendGate';
import { commitControlTs, controlTsFresh } from './controlWatermark';
import type { EnvelopeIntake } from '../transport/envelopeIntake';
import {
  PRESENCE_PREF_PREFIX,
  encodePresencePrefEnvelope,
  decodePresencePrefEnvelope,
} from './presenceEnvelope';
import { log } from '../logger';

export { PRESENCE_PREF_PREFIX };

/**
 * Что кому уже сообщено: { pubB64: true|false }.
 *
 * v4.32.325: своё у каждого аккаунта (scopedKvGet/Set). Это список открытых
 * ключей собеседников, то есть граф связей: общая запись смешивала адресатов
 * разных аккаунтов и переживала удаление профиля.
 *
 * v4.32.946: и шифртекстом. Здесь строка говорит больше, чем в profileSync: не
 * только кому слали, но и ЧТО — кому открыто время последнего входа, а кому
 * закрыто. Настройка приватности, разложенная по именам собеседников, в
 * открытом столбце базы лежать не должна.
 */
const SENT_KEY = 'presence:pref_sent';
const SENT_MAX = 1000;

type SentMap = Record<string, boolean>;

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

/**
 * Карта из базы; `null` — прочитать не удалось (v4.32.693).
 *
 * Раньше здесь стояло простое чтение, и отказ базы приходил тем же пустым
 * ответом, что и нетронутая карта. Дальше по этому ответу принимались два
 * разных решения, и оба неверных.
 *
 * Хуже — в recordSent: правка домешивалась к пустой карте и записывалась
 * поверх настоящей. Список «кому уже сказано» после этого состоял из одной
 * последней правки, а всё остальное исчезало НАВСЕГДА. Именно из него
 * broadcastLastSeenPref берёт тех, кого нет в контактах: человека удалили из
 * адресной книги ПОСЛЕ того, как ему сказали «показывай моё время», и отзыв
 * доходит до него только по этому списку. Потеряли список — человек видит
 * время входа, а его владелец уверен, что закрыл его всем.
 */
async function loadSent(pid: number): Promise<SentMap | null> {
  const read = await scopedKvTryGetSecretFor(pid, SENT_KEY);
  return read === null ? null : parseSentMap(read.value, isSentFlag);
}

/**
 * Очередь записей карты (v4.32.479).
 *
 * Здесь цена снимка выше, чем у профиля: восстановленное значение «ему сказано
 * показывать» отменяет уже отправленную просьбу «не показывай». Человек
 * вернёт настройку — а отправлять окажется нечего, потому что карта считает
 * собеседника уведомлённым. Пишем правку, а не снимок; см. sentMap.
 */
let sentTx: Promise<unknown> = Promise.resolve();

async function recordSent(pid: number, patch: SentMap): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const run = async () => {
    // v4.32.693: не прочитали — не пишем. Потерянная правка стоит лишней
    // отправки на следующем заходе, потерянная карта — недоставленного
    // отзыва; см. loadSent.
    const stored = await loadSent(pid);
    if (stored === null) {
      log.warn('presence_pref_sent_unreadable', { pid, patch: Object.keys(patch).length });
      return;
    }
    const merged = trimSentMap(mergeSentMap(stored, patch), SENT_MAX);
    // v4.32.946: отказ записи больше не молчит. Цена ему здесь та же, что у
    // потерянной правки выше: собеседник останется неуведомлённым, а мы
    // решим иначе — см. loadSent.
    if (!await scopedKvSetSecretCheckedFor(pid, SENT_KEY, JSON.stringify(merged))) {
      log.warn('presence_pref_sent_write_failed', { pid, patch: Object.keys(patch).length });
    }
  };
  const started = sentTx.then(run, run);
  sentTx = started.catch(() => {});
  await started;
}

async function sendPref(peerPubB64: string, show: boolean): Promise<boolean> {
  const svc = getMessagingService();
  if (!svc) return false;
  // v4.32.319: отказ не должен попадать в «уже сообщено» — повторить будет
  // некому. Человек переключил «время последнего входа» на «никто», просьба не
  // ушла, а в следующий раз мы решим, что собеседник в курсе. См. sendGate.
  if (!(await canReachPeer(peerPubB64))) {
    log.info('presence_pref_send_refused', { to: peerPubB64.slice(0, 12) });
    return false;
  }
  try {
    // v4.32.715: пустой ответ — отказ. Проверка выше знает только про
    // блокировку и часовой лимит; нет общего ключа, негодный peerDid,
    // исчерпанный лимит служебных конвертов и «нет маршрута в сеть» видны
    // только здесь. Записанный как доставка отказ означает неотправленную
    // просьбу «не показывай моё время последнего входа» — и повторить её
    // будет некому.
    const cid = await svc.sendMessage(
      peerPubB64,
      encodePresencePrefEnvelope({ show, ts: Date.now() })
    );
    if (!cid) {
      log.info('presence_pref_send_refused', { to: peerPubB64.slice(0, 12) });
      return false;
    }
    return true;
  } catch (e) {
    log.warn('presence_pref_send_failed', {
      to: peerPubB64.slice(0, 12),
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

async function currentVisibility(pid: number): Promise<LastSeenVisibility> {
  // v4.32.656: память службы принадлежит тому профилю, под которым она поднята.
  // Для чужого номера ни брать оттуда запасное решение, ни писать туда своё
  // нельзя: так настройка одного аккаунта отвечала за рассылку другого — и в
  // ту, и в другую сторону. Чужому номеру остаётся осторожное 'nobody'.
  const mine = pid === presenceOwnerPid();
  try {
    // v4.32.311: см. privacyPrefs — настройка своя у каждого аккаунта.
    // v4.32.475: отказ базы больше не читается как 'everybody'. Берём последнее
    // прочитанное решение, а пока ничего не прочитано — осторожное 'nobody':
    // рассылка «показывайте моё время» на пустом месте не отзывается.
    const read = await privacyPrefTryGetFor(pid, 'privacy_last_seen_visibility');
    if (read === null) return mine ? effectiveMyLastSeenVisibility() : 'nobody';
    const v = parseLastSeenVisibility(read.value);
    if (mine) setMyLastSeenVisibility(v);
    return v;
  } catch {
    return mine ? effectiveMyLastSeenVisibility() : 'nobody';
  }
}

/**
 * Итог рассылки (v4.32.901).
 *
 * `sent_map_unreadable` — карта отправленного не прочиталась, и список
 * адресатов вышел неполным: бывшие контакты в него не попали. Настройка при
 * этом сохранена, а рассылка по нынешним контактам прошла.
 */
export type LastSeenBroadcast = 'ok' | 'sent_map_unreadable';

/**
 * Разослать текущее решение. Вызывается при изменении настройки.
 *
 * Адресаты — контакты И все, кому решение уже отправлялось: человека могли
 * удалить из контактов после того, как ему сказали «показывай», и тогда
 * отзыв обязан до него дойти.
 */
export async function broadcastLastSeenPref(): Promise<LastSeenBroadcast> {
  // v4.32.479: решение, адресная книга и карта отправленного — одного профиля,
  // выбранного здесь. Рассылка ждёт сеть на каждом адресате, и к её концу
  // активным может быть уже другой аккаунт.
  const pid = activeProfileId();
  const visibility = await currentVisibility(pid);
  let contactPubs: string[] = [];
  try {
    contactPubs = (await listContactsFor(pid)).map((c) => c.peerPublicKey);
  } catch (e) {
    log.warn('presence_pref_contacts_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  const contactSet = new Set(contactPubs);
  // v4.32.901: `null` здесь значит «прочитать не вышло», и для дедупликации
  // пустая карта безвредна — лишняя отправка дешева. Но из этой же карты
  // берутся ТЕ, КОГО УЖЕ НЕТ В КОНТАКТАХ, а отзыв обязан дойти именно до них:
  // отметку «был в сети» ведёт получатель, сервера, который её спрячет, нет,
  // и второго захода не будет — рассылка идёт только по нажатию, а
  // syncLastSeenPrefTo срабатывает при открытии переписки, которой с
  // удалённым контактом уже не открыть. Молча сведя отказ к пустой карте,
  // экран показывал «Никто», а бывший контакт продолжал видеть время входа.
  const sentRead = await loadSent(pid);
  const sent = sentRead ?? {};
  const targets = new Set<string>([...contactPubs, ...Object.keys(sent)]);
  const fresh: SentMap = {};
  for (const peer of targets) {
    if (activeProfileId() !== pid) {
      log.info('presence_pref_profile_switched', { pid, done: Object.keys(fresh).length });
      break;
    }
    const show = shouldShareLastSeenWith({ visibility, isContact: contactSet.has(peer) });
    if (sent[peer] === show || fresh[peer] === show) continue;
    if (await sendPref(peer, show)) fresh[peer] = show;
  }
  await recordSent(pid, fresh);
  log.info('presence_pref_broadcast', {
    visibility,
    targets: targets.size,
    sent: Object.keys(fresh).length,
    sentMapUnreadable: sentRead === null,
  });
  // Карта на диске цела: recordSent отказывается писать поверх непрочитанной
  // (v4.32.693), так что повтор той же настройки действительно догонит всех.
  return sentRead === null ? 'sent_map_unreadable' : 'ok';
}

/**
 * Сообщить решение конкретному собеседнику, если он его ещё не знает.
 * Вызывается при открытии чата — так просьба доходит и до тех, кого нет в
 * контактах (рассылка их не охватывает).
 */
export async function syncLastSeenPrefTo(peerPubB64: string): Promise<void> {
  if (!peerPubB64) return;
  const pid = activeProfileId();
  const visibility = await currentVisibility(pid);
  let isContact = false;
  try {
    isContact = (await listContactsFor(pid)).some((c) => c.peerPublicKey === peerPubB64);
  } catch { /* считаем «не контакт» — так строже */ }
  const show = shouldShareLastSeenWith({ visibility, isContact });
  const sent = (await loadSent(pid)) ?? {};
  // «Показывать» — состояние по умолчанию у любого клиента; пока мы ничего не
  // просили, отправлять «да» незачем.
  if (sent[peerPubB64] === show || (sent[peerPubB64] === undefined && show)) return;
  if (await sendPref(peerPubB64, show)) {
    await recordSent(pid, { [peerPubB64]: show });
  }
}

/**
 * Применяет входящий конверт.
 *
 * v4.32.759: отвечает словом, а не `true`. Прежний `boolean` значил «конверт
 * наш» — и вызывающим не читался вовсе: ветка в messaging.ts объявляла кадр
 * разобранным в любом исходе. «Разобрано» же двигает метку докуда прочитано, а
 * relay отдаёт накопленное только по ней и повтора у служебного конверта нет:
 * занятая на секунду база стоила просьбы спрятать время входа навсегда. Порядок «проверить знак —
 * применить — сдвинуть знак» тут уже правильный (v4.32.751), но починить он мог
 * только повтор, которого никто не присылает.
 *
 * Откладываем ровно то, что пройдёт само. Устаревший повтор, мусор вместо
 * конверта и конверт без отправителя годными не станут — они разобраны.
 */
export async function handleIncomingLastSeenPref(
  text: string,
  senderPubB64: string | undefined,
  ownerProfileId: number
): Promise<EnvelopeIntake> {
  if (!text.startsWith(PRESENCE_PREF_PREFIX)) return 'consumed';
  const env = decodePresencePrefEnvelope(text);
  if (!env || !senderPubB64) return 'consumed';
  // Решение относится к ПОДПИСАННОМУ отправителю: поля «за кого» в конверте
  // нет намеренно, иначе один контакт прятал бы другого.
  //
  // v4.32.485: и к тому аккаунту, в который конверт пришёл. Номер берётся у
  // вызывающего, а не у работающей службы: адресат просьбы — владелец пары
  // ключей, которой конверт расшифрован, и он мог перестать быть видимым,
  // пока сообщение шло.
  // v4.32.615: повтор старого конверта откатывал состояние. Окно приёма — 30
  // суток, а единственной защитой от повтора был Set в памяти, гибнущий при
  // перезапуске; служебный конверт вдобавок выходит раньше, чем в базе
  // появится строка с его messageId. Отметка времени монотонна для каждой
  // пары «профиль — собеседник» (см. controlWatermark.ts).
  if (!(await controlTsFresh('presence', senderPubB64, ownerProfileId, env.ts))) return 'consumed';
  const applied = await setPeerLastSeenAllowedFor(ownerProfileId, senderPubB64, env.show);
  // v4.32.751: знак двигаем ПОСЛЕ применения — та же пара, что у запрета
  // копирования (v4.32.655) и у таймера автоудаления (v4.32.750). Сдвиг до
  // него делал отказ вечным: запись могла не лечь, а повтор того же конверта
  // отвергался уже как старый. Починиться это не могло ничем — отправитель
  // помнит, что просьбу мы получили (см. recordSent ниже), и второй раз её не
  // шлёт, а сказать ему «не дошло» нечем.
  if (!applied) {
    log.warn('presence_pref_apply_failed', { from: senderPubB64.slice(0, 12), show: env.show });
    return 'deferred';
  }
  await commitControlTs('presence', senderPubB64, ownerProfileId, env.ts);
  log.info('presence_pref_applied', { from: senderPubB64.slice(0, 12), show: env.show });
  return 'consumed';
}
