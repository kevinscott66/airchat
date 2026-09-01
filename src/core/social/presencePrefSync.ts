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
import { scopedKvGetFor, scopedKvSetFor } from '../storage/profileScopedKv';
import { listContactsFor } from './contacts';
import { profileManager } from '../identity/profileManager';
import { mergeSentMap, parseSentMap, isSentFlag, trimSentMap } from './sentMap';
import { getMessagingService } from './messaging';
import {
  setPeerLastSeenAllowedFor,
  setMyLastSeenVisibility,
  effectiveMyLastSeenVisibility,
} from './presenceService';
import { shouldShareLastSeenWith, parseLastSeenVisibility, type LastSeenVisibility } from './presencePolicy';
import { privacyPrefTryGetFor } from '../settings/privacyPrefs';
import { canReachPeer } from './sendGate';
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
 */
const SENT_KEY = 'presence:pref_sent';
const SENT_MAX = 1000;

type SentMap = Record<string, boolean>;

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

async function loadSent(pid: number): Promise<SentMap> {
  return parseSentMap(await scopedKvGetFor(pid, SENT_KEY), isSentFlag);
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
    const merged = trimSentMap(mergeSentMap(await loadSent(pid), patch), SENT_MAX);
    await scopedKvSetFor(pid, SENT_KEY, JSON.stringify(merged));
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
    await svc.sendMessage(peerPubB64, encodePresencePrefEnvelope({ show, ts: Date.now() }));
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
  try {
    // v4.32.311: см. privacyPrefs — настройка своя у каждого аккаунта.
    // v4.32.475: отказ базы больше не читается как 'everybody'. Берём последнее
    // прочитанное решение, а пока ничего не прочитано — осторожное 'nobody':
    // рассылка «показывайте моё время» на пустом месте не отзывается.
    const read = await privacyPrefTryGetFor(pid, 'privacy_last_seen_visibility');
    if (read === null) return effectiveMyLastSeenVisibility();
    const v = parseLastSeenVisibility(read.value);
    setMyLastSeenVisibility(v);
    return v;
  } catch {
    return effectiveMyLastSeenVisibility();
  }
}

/**
 * Разослать текущее решение. Вызывается при изменении настройки.
 *
 * Адресаты — контакты И все, кому решение уже отправлялось: человека могли
 * удалить из контактов после того, как ему сказали «показывай», и тогда
 * отзыв обязан до него дойти.
 */
export async function broadcastLastSeenPref(): Promise<void> {
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
  const sent = await loadSent(pid);
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
  log.info('presence_pref_broadcast', { visibility, targets: targets.size, sent: Object.keys(fresh).length });
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
  const sent = await loadSent(pid);
  // «Показывать» — состояние по умолчанию у любого клиента; пока мы ничего не
  // просили, отправлять «да» незачем.
  if (sent[peerPubB64] === show || (sent[peerPubB64] === undefined && show)) return;
  if (await sendPref(peerPubB64, show)) {
    await recordSent(pid, { [peerPubB64]: show });
  }
}

/**
 * Применяет входящую просьбу. true — конверт наш (даже если отброшен):
 * вызывающий не должен сохранять его как обычное сообщение.
 */
export async function handleIncomingLastSeenPref(
  text: string,
  senderPubB64: string | undefined,
  ownerProfileId: number
): Promise<boolean> {
  if (!text.startsWith(PRESENCE_PREF_PREFIX)) return false;
  const env = decodePresencePrefEnvelope(text);
  if (!env || !senderPubB64) return true;
  // Решение относится к ПОДПИСАННОМУ отправителю: поля «за кого» в конверте
  // нет намеренно, иначе один контакт прятал бы другого.
  //
  // v4.32.485: и к тому аккаунту, в который конверт пришёл. Номер берётся у
  // вызывающего, а не у работающей службы: адресат просьбы — владелец пары
  // ключей, которой конверт расшифрован, и он мог перестать быть видимым,
  // пока сообщение шло.
  setPeerLastSeenAllowedFor(ownerProfileId, senderPubB64, env.show);
  log.info('presence_pref_applied', { from: senderPubB64.slice(0, 12), show: env.show });
  return true;
}
