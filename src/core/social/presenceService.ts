/**
 * PresenceService — отслеживает статус "последний раз в сети".
 * Заменяет захардкоженное "в сети" на реальные данные.
 *
 * Архитектура:
 * - Каждое входящее сообщение / typing-сигнал обновляет last-seen для пира.
 * - Собственный presence публикуется в pubsub при открытии приложения.
 * - Privacy: если пользователь включил "Скрыть статус «онлайн»" — свой presence не публикуется.
 * - Bucket-based: онлайн (< 1 мин) / недавно (< 5 мин) / N мин назад / N часов назад / N дней назад.
 */

import { AppState, type AppStateStatus } from 'react-native';
import { scopedKvGetFor, scopedKvSetFor } from '../storage/profileScopedKv';
import { ownerPidForPublicKeyB64 } from '../identity/ownerPidLookup';
import { ownFieldGetFor } from '../identity/ownProfile';
import { pubsubPublish, pubsubSubscribe } from '../transport/ipfs/pubsub';
import { isIpfsEnabled } from '../transport/ipfs/heliaNode';
import { listContacts } from './contacts';
import { privacyPrefTryGet } from '../settings/privacyPrefs';
import { sanitizePeerStatus } from './peerStatus';
import { parseHiddenPeers, withHiddenPeer } from './hiddenPeers';
import { type LastSeenBucket, lastSeenLabel } from '../time/lastSeenLabel';
import { log } from '../logger';
import { runWithConcurrency } from '../utils/runWithConcurrency';
import {
  parseLastSeenVisibility,
  canSeePeerLastSeen,
  type LastSeenVisibility,
} from './presencePolicy';

export type { LastSeenBucket };

export type PresenceState = {
  bucket: LastSeenBucket;
  /** Точное unix-ms время последней активности (0 = неизвестно). */
  lastActiveAt: number;
  /** Человекочитаемая строка: "в сети", "был(а) 5 мин назад" и т.д. */
  label: string;
  /** Пользовательский статус (может быть пустой строкой). */
  status: string;
};

const KV_PREFIX = 'presence:last_seen:';
/**
 * v4.32.278: удаление контакта тоже стирает эту запись, и до этой версии оно
 * собирало ключ своим литералом. Один источник — чтобы «удалили контакт, а
 * время его последнего входа осталось» не появилось при первом же переименовании.
 */
export function presenceLastSeenKey(peerPubB64: string): string {
  return `${KV_PREFIX}${peerPubB64}`;
}
/**
 * Список тех, кто просил не показывать своё время входа.
 *
 * Одним ключом, а не `presence:allow:<pub>` на каждого: список нужно
 * восстановить ЦЕЛИКОМ при старте, в том числе для тех, кого нет в
 * контактах, — а loadPersistedPresence получает только контакты.
 */
const HIDDEN_PEERS_KEY = 'presence:hidden_peers';

/**
 * Чей это presence (v4.32.482).
 *
 * Память служба чистит при переключении аккаунта (см. stopPresenceBroadcast),
 * а вот записи в kv лежали под общими именами — то есть чистка снимала ровно
 * половину: следующий профиль поднимал их обратно с диска для контактов,
 * которые есть в обоих, и видел «был в сети» из чужой переписки. Просьба
 * «не показывай моё время входа» пересекала границу аккаунтов так же. Мимо
 * уборки удалённого профиля (она сметает `p<id>:%`) эти записи проходили
 * целиком и доставались следующему профилю с тем же номером.
 *
 * Номер выставляется при загрузке и при старте рассылки — то есть тогда же,
 * когда служба поднимается под конкретную пару ключей. При остановке он НЕ
 * сбрасывается: опоздавшее входящее сообщение принадлежит прежнему профилю, и
 * записать его надо туда же, а не первому попавшемуся.
 */
let presencePid = 1;

/** Map<peerPubB64, timestampMs> — in-memory кэш. */
const lastSeenCache = new Map<string, number>();

/**
 * v4.32.238. Кто просил не показывать его «был(а) в сети». Решение принимает
 * сам собеседник и присылает конвертом \x12pres: (см. presencePolicy.ts);
 * отсутствие в списке = показывать можно.
 */
const hiddenPeers = new Set<string>();

/** Своя настройка «кто видит моё время входа»; нужна синхронно в getPresenceState. */
let myVisibility: LastSeenVisibility = 'everybody';

/**
 * Прочитана ли настройка хоть раз (v4.32.475).
 *
 * «Ещё не прочитали» — это не «показывать всем». Настройка живёт в той же
 * базе, что и переписка, и заминка при старте (её же ловит kv_get_failed)
 * приходила сюда неотличимо от «человек ничего не выбирал» — то есть
 * присутствие начинало рассылаться именно тогда, когда про запрет узнать было
 * неоткуда. Пока ответа нет, действует 'nobody', и первое же удачное чтение
 * возвращает настоящее решение.
 */
let myVisibilityKnown = false;

/**
 * Обновить свою настройку. Вызывается при старте и при её изменении в
 * настройках — от неё зависит и публикация своего статуса, и взаимность
 * (скрыл своё время — не видишь чужое).
 */
export function setMyLastSeenVisibility(raw: string | null | undefined): void {
  myVisibility = parseLastSeenVisibility(raw);
  myVisibilityKnown = true;
}

export function getMyLastSeenVisibility(): LastSeenVisibility {
  return myVisibility;
}

/**
 * Решение, по которому и надо действовать: пока настройка не прочитана —
 * 'nobody' (v4.32.475). Нераспубликованное присутствие догонит следующий такт,
 * разошедшееся не отозвать.
 */
export function effectiveMyLastSeenVisibility(): LastSeenVisibility {
  return myVisibilityKnown ? myVisibility : 'nobody';
}

/**
 * Прочитать свою настройку. Возвращает false, если база не ответила.
 *
 * Неудача возвращает состояние в «не знаем» — в том числе после удачных
 * чтений раньше. Прошлый ответ не значит, что решение с тех пор не поменяли:
 * настройки пишет тот же файл базы, который сейчас не читается. Тишина на
 * один такт восстановится сама, разошедшееся присутствие — нет.
 */
export async function loadMyLastSeenVisibility(): Promise<boolean> {
  const read = await privacyPrefTryGet('privacy_last_seen_visibility');
  if (read === null) {
    myVisibilityKnown = false;
    return false;
  }
  setMyLastSeenVisibility(read.value);
  return true;
}

/**
 * Запомнить просьбу собеседника у ЕГО адресата (v4.32.485). `allow === false`
 * дополнительно СТИРАЕТ уже накопленное время: человек попросил его не
 * отмечать — значит и хранить собранное раньше не нужно.
 *
 * Просьба приходит подписанным конвертом в конкретный аккаунт, а служба
 * присутствия в приложении одна. Пока номера совпадают, работает прежний
 * путь — через память. Если конверт достался другому аккаунту (позднее
 * входящее после переключения), память трогать нельзя: она принадлежит
 * работающему профилю. Тогда правится только запись адресата — он поднимет её
 * при своём следующем старте.
 */
export function setPeerLastSeenAllowedFor(
  ownerProfileId: number,
  peerPubB64: string,
  allow: boolean
): void {
  if (ownerProfileId !== presencePid) {
    void persistHiddenPeerFor(ownerProfileId, peerPubB64, allow);
    return;
  }
  const next = withHiddenPeer([...hiddenPeers], peerPubB64, !allow);
  if (!allow) {
    if (next) hiddenPeers.add(peerPubB64);
    lastSeenCache.delete(peerPubB64);
    void scopedKvSetFor(presencePid, presenceLastSeenKey(peerPubB64), '0').catch(() => { /* ignore */ });
  } else if (next) {
    hiddenPeers.delete(peerPubB64);
  }
  if (next) {
    void scopedKvSetFor(presencePid, HIDDEN_PEERS_KEY, JSON.stringify(next)).catch(() => { /* ignore */ });
  }
  emitPresence(peerPubB64);
}

/** Просьба, адресованная работающему профилю. */
export function setPeerLastSeenAllowed(peerPubB64: string, allow: boolean): void {
  setPeerLastSeenAllowedFor(presencePid, peerPubB64, allow);
}

/**
 * Тот же учёт для аккаунта, которого сейчас нет на экране: чтение — правка —
 * запись прямо в его записи. Провал чтения НЕ приводит к записи: иначе один
 * сбой базы стёр бы весь накопленный список запретов чужого аккаунта.
 */
async function persistHiddenPeerFor(
  ownerProfileId: number,
  peerPubB64: string,
  allow: boolean
): Promise<void> {
  try {
    if (!allow) {
      await scopedKvSetFor(ownerProfileId, presenceLastSeenKey(peerPubB64), '0');
    }
    const list = parseHiddenPeers(await scopedKvGetFor(ownerProfileId, HIDDEN_PEERS_KEY));
    const next = withHiddenPeer(list, peerPubB64, !allow);
    if (!next) return;
    await scopedKvSetFor(ownerProfileId, HIDDEN_PEERS_KEY, JSON.stringify(next));
  } catch (e) {
    log.warn('presence_hidden_peer_persist_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

const presenceListeners = new Set<(peerPubB64: string, state: PresenceState) => void>();

export function subscribePresence(
  cb: (peerPubB64: string, state: PresenceState) => void
): () => void {
  presenceListeners.add(cb);
  return () => presenceListeners.delete(cb);
}

function emitPresence(peerPubB64: string): void {
  const state = getPresenceState(peerPubB64);
  for (const cb of presenceListeners) {
    try { cb(peerPubB64, state); } catch { /* ignore */ }
  }
}

// v4.32.199 (Round-29 #3): FIFO cap matches peerStatusCache at line 167.
// Previously lastSeenCache grew unbounded across long sessions with many
// subscribed peers.
const LAST_SEEN_CACHE_MAX = 2000;

/**
 * Вызывать при любой активности пира (получено сообщение, typing, etc.) —
 * с номером аккаунта, ДО КОТОРОГО эта активность дошла (v4.32.485).
 *
 * Отметка «был(а) в сети» считается целиком у получателя, то есть это его
 * собственная запись о чужом человеке. Раньше она уходила под номер
 * работающей службы: позднее входящее прежнего аккаунта записывало время в
 * новый — тот показывал «был 2 мин назад» про человека из чужой переписки, а
 * иногда и про того, кого у него нет в контактах.
 */
export function recordPeerActivityFor(
  ownerProfileId: number,
  peerPubB64: string,
  ts?: number
): void {
  const now = ts ?? Date.now();
  if (ownerProfileId !== presencePid) {
    // Аккаунт не на экране: его список запретов лежит в базе, а не в памяти —
    // сверяемся с ним, иначе просьба «не отмечать меня» пережила бы
    // переключение только у видимого профиля.
    void recordForeignActivity(ownerProfileId, peerPubB64, now);
    return;
  }
  // v4.32.238: собеседник попросил не отмечать его — не записываем вообще.
  // Именно здесь, а не при показе: «был(а) в сети» целиком считается на
  // стороне получателя, и просьбу можно исполнить только не собирая данные.
  if (hiddenPeers.has(peerPubB64)) return;
  if (lastSeenCache.size >= LAST_SEEN_CACHE_MAX && !lastSeenCache.has(peerPubB64)) {
    const oldestKey = lastSeenCache.keys().next().value;
    if (oldestKey !== undefined) lastSeenCache.delete(oldestKey);
  }
  lastSeenCache.set(peerPubB64, now);
  void scopedKvSetFor(presencePid, presenceLastSeenKey(peerPubB64), String(now)).catch(() => { /* ignore */ });
  emitPresence(peerPubB64);
}

/** Активность, дошедшая до работающего профиля. */
export function recordPeerActivity(peerPubB64: string, ts?: number): void {
  recordPeerActivityFor(presencePid, peerPubB64, ts);
}

/**
 * Запись времени для аккаунта, которого нет на экране. Слушателей не трогает:
 * показывать нечего — переписка этого аккаунта не открыта.
 */
async function recordForeignActivity(
  ownerProfileId: number,
  peerPubB64: string,
  now: number
): Promise<void> {
  try {
    const list = parseHiddenPeers(await scopedKvGetFor(ownerProfileId, HIDDEN_PEERS_KEY));
    if (list.includes(peerPubB64)) return;
    await scopedKvSetFor(ownerProfileId, presenceLastSeenKey(peerPubB64), String(now));
  } catch { /* ignore */ }
}

/** Загрузить сохранённые last-seen и просьбы собеседников из KV при старте. */
export async function loadPersistedPresence(peerPubB64List: string[], ownerPid: number): Promise<void> {
  presencePid = ownerPid;
  try {
    // v4.32.311: «кто видит, когда я в сети» — своё у каждого аккаунта.
    // v4.32.475: не прочитали — так и остаётся «не знаем», а не 'everybody';
    // следующий такт присутствия попробует ещё раз.
    await loadMyLastSeenVisibility();
  } catch { /* остаётся «не знаем» — см. effectiveMyLastSeenVisibility */ }
  // Список «не показывать» восстанавливается ПЕРВЫМ: иначе между стартом и
  // его загрузкой входящие сообщения успели бы записать время того, кто
  // просил себя не отмечать.
  try {
    for (const p of parseHiddenPeers(await scopedKvGetFor(presencePid, HIDDEN_PEERS_KEY))) {
      hiddenPeers.add(p);
    }
  } catch { /* ignore */ }
  await runWithConcurrency(peerPubB64List, 12, async (k) => {
    try {
      if (hiddenPeers.has(k)) return;
      const v = await scopedKvGetFor(presencePid, presenceLastSeenKey(k));
      if (v) {
        const ts = parseInt(v, 10);
        if (ts > 0) lastSeenCache.set(k, ts);
      }
    } catch { /* ignore */ }
  });
}

/** Получить текущий presence-стейт для пира. */
export function getPresenceState(peerPubB64: string): PresenceState {
  const status = peerStatusCache.get(peerPubB64) ?? '';
  // v4.32.238: взаимность и просьба собеседника. Отдельная ветка от «данных
  // нет» по смыслу, но наружу выглядит одинаково — «не в сети», без намёка
  // на то, скрыт человек или просто давно не заходил.
  if (!canSeePeerLastSeen({
    peerAllows: hiddenPeers.has(peerPubB64) ? false : undefined,
    // v4.32.475: пока своё решение не прочитано, взаимность считается по
    // осторожному 'nobody' — иначе чужое время видно, а своё, возможно,
    // скрыто, и правило взаимности нарушено в свою пользу.
    myVisibility: effectiveMyLastSeenVisibility(),
  })) {
    return { bucket: 'never', lastActiveAt: 0, label: 'не в сети', status };
  }
  const lastActive = lastSeenCache.get(peerPubB64) ?? 0;
  if (!lastActive) {
    return { bucket: 'never', lastActiveAt: 0, label: 'не в сети', status };
  }

  const { bucket, label } = lastSeenLabel(lastActive, Date.now());
  return { bucket, lastActiveAt: lastActive, label, status };
}

// ─── Own presence broadcasting ───────────────────────────────────────────────

const PRESENCE_TOPIC_PREFIX = '/airchat/v1/presence/';
const HEARTBEAT_INTERVAL_MS = 30_000;

type PresenceEnvelope = { pubB64: string; ts: number; status?: string };

// v4.32.151 T6: heartbeatTimer теперь setTimeout-рекурсия (для динамического
// backoff), а retrySweepTimer остался setInterval (его период не меняется).
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let retrySweepTimer: ReturnType<typeof setInterval> | null = null;
// Экспоненциальный backoff для heartbeat при ошибках publish; сбрасывается
// в 0 при успешной публикации. Capped max 5 min.
let consecutiveHeartbeatFailures = 0;
const MAX_HEARTBEAT_BACKOFF_MS = 5 * 60_000;
// AppState-suppression: публикуем heartbeat только когда приложение active.
// При переходе в active форсим немедленный broadcast.
let currentAppState: AppStateStatus = AppState.currentState;
let appStateSub: { remove: () => void } | null = null;
/**
 * v4.32.144 (AUDIT P1 T5): per-contact subscribe state. Replaces the flat
 * `presenceUnsubs` array that silently absorbed pubsub failures as no-op
 * unsubs, leaving presence permanently dead if the IPFS node wasn't ready
 * at cold start. With a keyed map we can (a) avoid duplicate subscriptions,
 * (b) detect which contacts still need subscribing, and (c) resubscribe
 * newly-added contacts on every sweep.
 */
const subscribedByPeer = new Map<string, () => void>();
const failedPeers = new Set<string>();
let myPresencePubB64: string | null = null;

const RETRY_SWEEP_INTERVAL_MS = 60_000;

/** In-memory cache of peer custom status strings received via presence. */
const peerStatusCache = new Map<string, string>();

// v4.32.377: точечный getPeerStatus отсюда убран — статус собеседника
// приезжает на экран вместе с присутствием, одним снимком, и отдельно его не
// спрашивал никто.

/**
 * v4.32.144 (AUDIT P1 T5): idempotent per-peer subscribe helper. On success
 * records the unsubscribe fn in `subscribedByPeer`; on failure records the
 * peer in `failedPeers` so the retry sweep can pick it up once the IPFS
 * pubsub node becomes ready.
 */
async function subscribeToPeer(peerPubB64: string, myPubB64: string): Promise<boolean> {
  if (subscribedByPeer.has(peerPubB64)) return true;
  const topic = `${PRESENCE_TOPIC_PREFIX}${peerPubB64}`;
  try {
    const unsub = await pubsubSubscribe(topic, ({ data }) => {
      try {
        // v4.32.196 (Round-26 #3): presence envelopes are tiny (ts + short
        // status string). 4KB is generous; anything larger is garbage/attack.
        if (data.byteLength > 4096) return;
        const env = JSON.parse(new TextDecoder().decode(data)) as PresenceEnvelope;
        // v4.32.187 (Round-17 #3): presence spoofing hardening. The pubsub
        // topic is keyed by the peer's pubkey (`presence/<peerPubB64>`), but
        // any peer can publish to any topic. Previously we trusted
        // `env.pubB64` verbatim — an attacker could mark *any* contact
        // online with `ts: 9e15` or poison their cached status string, and
        // grow caches unboundedly with garbage keys. Use the topic identity
        // instead and sanity-check ts/status.
        const now = Date.now();
        if (typeof env.ts !== 'number' || !isFinite(env.ts)) return;
        // Allow small future skew (5min) and 7d past window.
        const ts = Math.max(now - 7 * 24 * 60 * 60_000, Math.min(env.ts, now + 5 * 60_000));
        recordPeerActivity(peerPubB64, ts);
        if (typeof env.status === 'string') {
          // v4.32.375: до этой версии здесь стояла одна обрезка по длине —
          // единственное текстовое поле из сети, не проходившее чистку вовсе.
          // Правило см. peerStatus: строка однострочная и стоит там же, где
          // приложение говорит своим голосом.
          const status = sanitizePeerStatus(env.status);
          if (status) {
            // v4.32.188 (Round-18 #3): FIFO cap so caches can't grow
            // without bound across a long session with many peers.
            if (peerStatusCache.size >= 2000 && !peerStatusCache.has(peerPubB64)) {
              const firstKey = peerStatusCache.keys().next().value;
              if (firstKey !== undefined) peerStatusCache.delete(firstKey);
            }
            peerStatusCache.set(peerPubB64, status);
          } else {
            peerStatusCache.delete(peerPubB64);
          }
        }
      } catch { /* malformed — ignore */ }
    });
    // pubsubSubscribe returns null when the IPFS client isn't ready or the
    // subscribe call threw internally. Treat as a retryable failure.
    if (!unsub) {
      failedPeers.add(peerPubB64);
      log.warn('presence_subscribe_failed', { peer: peerPubB64.slice(0, 12), reason: 'no_client' });
      return false;
    }
    // Guard: if stop was called (or identity switched) between await and
    // resolve, drop the subscription we just created instead of leaking it.
    if (myPresencePubB64 !== myPubB64) {
      try { unsub(); } catch { /* ignore */ }
      return false;
    }
    subscribedByPeer.set(peerPubB64, unsub);
    failedPeers.delete(peerPubB64);
    return true;
  } catch (e) {
    failedPeers.add(peerPubB64);
    log.warn('presence_subscribe_failed', {
      peer: peerPubB64.slice(0, 12),
      err: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * v4.32.144 (AUDIT P1 T5): periodic sweep that (a) retries previously-failed
 * subscriptions (pubsub node may have come online after cold start) and
 * (b) picks up contacts added AFTER startPresenceBroadcast ran.
 */
async function resubscribeFailed(myPubB64: string): Promise<void> {
  if (myPresencePubB64 !== myPubB64) return;
  // Fresh scan — new contacts may exist that weren't known at startup.
  let contactIds: string[] = [];
  try {
    const contacts = await listContacts();
    contactIds = contacts.map((c) => c.peerPublicKey);
  } catch (e) {
    log.warn('presence_sweep_list_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  const targets = new Set<string>([...failedPeers, ...contactIds]);
  for (const peer of targets) {
    if (myPresencePubB64 !== myPubB64) return;
    if (subscribedByPeer.has(peer)) continue;
    await subscribeToPeer(peer, myPubB64);
  }
}

/**
 * Start broadcasting own presence and subscribing to contacts' presence topics.
 * Call once after key pair is ready and contacts are loaded.
 *
 * v4.32.144 (AUDIT P1 T5): idempotent — safe to call again with the same key
 * to force a re-arm. The `subscribedByPeer` map prevents duplicate
 * subscriptions; the heartbeat timer is cleared before re-arming so it
 * cannot stack.
 */
export async function startPresenceBroadcast(myPubB64: string): Promise<void> {
  // Профиль — из той же пары ключей, которой служба представляется сети.
  // Ключ не разобрался — остаётся номер, выставленный при загрузке.
  const keyPid = ownerPidForPublicKeyB64(myPubB64);
  if (keyPid !== null) presencePid = keyPid;
  // v4.32.144: dropped the `myPresencePubB64 === myPubB64` early-return guard
  // so a caller can force a re-arm. If the identity changed, tear down first.
  if (myPresencePubB64 !== null && myPresencePubB64 !== myPubB64) {
    await stopPresenceBroadcast();
  }
  myPresencePubB64 = myPubB64;

  // v4.32.227 (PERF): presence subscribe + heartbeat both ride IPFS pubsub,
  // which is kill-switched on mobile (isIpfsEnabled()===false) → every subscribe
  // and publish returns null. The old code still armed the 60s retry sweep + 30s
  // heartbeat, producing 370+ guaranteed-failing presence_subscribe_failed events
  // and per-tick kvGet/listContacts churn that starved the JS thread for nothing.
  // "Был(а) в сети" does NOT depend on this path — it is fed by recordPeerActivity
  // from inbound messages (messaging.ts). So on mobile we skip arming entirely.
  if (!isIpfsEnabled()) {
    log.info('presence_skipped_no_ipfs');
    return;
  }

  // Initial subscribe pass — failures here are recorded in failedPeers and
  // the retry sweep will try again every RETRY_SWEEP_INTERVAL_MS.
  try {
    const contacts = await listContacts();
    for (const c of contacts) {
      await subscribeToPeer(c.peerPublicKey, myPubB64);
    }
  } catch (e) {
    log.warn('presence_initial_list_failed', { err: e instanceof Error ? e.message : String(e) });
  }

  // v4.32.151 T6: heartbeat с AppState-suppression и экспоненциальным backoff
  // при ошибках publish. Пропускаем тик в background; при возврате в active
  // триггерим немедленный broadcast и сбрасываем backoff.
  const broadcast = async (): Promise<boolean> => {
    // v4.32.169: respect privacy_last_seen_visibility. 'nobody' = skip publish.
    // v4.32.238: значение берётся из кэша (его же использует взаимность), а
    // «Контакты» здесь по-прежнему не различается от «Все» — тема pubsub
    // общая для всех подписчиков. Разделение сделано в другом месте: адресный
    // конверт \x12pres: уходит каждому собеседнику отдельно, и именно он
    // работает на телефонах, где pubsub выключен целиком.
    // v4.32.475: настройку могло не удаться прочитать при старте — пробуем
    // ещё раз здесь, раз в такт, вместо того чтобы вещать вслепую.
    if (!myVisibilityKnown) await loadMyLastSeenVisibility().catch(() => false);
    if (effectiveMyLastSeenVisibility() === 'nobody') return true;
    const topic = `${PRESENCE_TOPIC_PREFIX}${myPubB64}`;
    // Статус — своего профиля, а не открытого на экране: рассылка идёт под
    // парой ключей этой службы (v4.32.482).
    const status = await ownFieldGetFor(presencePid, 'user_custom_status').catch(() => '');
    const env: PresenceEnvelope = { pubB64: myPubB64, ts: Date.now() };
    // Чистится и на отправке: иначе свой статус выглядел бы у собеседника
    // иначе, чем у автора, — то же правило, что у опроса (pollEnvelope).
    const safeStatus = sanitizePeerStatus(status);
    if (safeStatus) env.status = safeStatus;
    const payload = new TextEncoder().encode(JSON.stringify(env));
    try {
      await pubsubPublish(topic, payload);
      return true;
    } catch {
      return false;
    }
  };

  const scheduleNextHeartbeat = (): void => {
    if (myPresencePubB64 !== myPubB64) return;
    const backoff = Math.min(
      HEARTBEAT_INTERVAL_MS * Math.pow(2, consecutiveHeartbeatFailures),
      MAX_HEARTBEAT_BACKOFF_MS
    );
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); }
    heartbeatTimer = setTimeout(() => { void tick(); }, backoff);
  };

  const tick = async (): Promise<void> => {
    if (myPresencePubB64 !== myPubB64) return;
    // Пропускаем publish в background — мы уже не «в сети». Переход в active
    // AppState-listener сам форсит немедленный broadcast.
    if (currentAppState !== 'active') {
      scheduleNextHeartbeat();
      return;
    }
    const ok = await broadcast();
    if (ok) {
      consecutiveHeartbeatFailures = 0;
    } else {
      consecutiveHeartbeatFailures = Math.min(consecutiveHeartbeatFailures + 1, 5);
      log.warn('presence_heartbeat_failed', { failures: consecutiveHeartbeatFailures });
    }
    scheduleNextHeartbeat();
  };

  // Снять прошлую AppState-подписку (если была) и навесить новую.
  if (appStateSub) { try { appStateSub.remove(); } catch { /* ignore */ } appStateSub = null; }
  currentAppState = AppState.currentState;
  appStateSub = AppState.addEventListener('change', (next) => {
    const wasActive = currentAppState === 'active';
    currentAppState = next;
    if (!wasActive && next === 'active' && myPresencePubB64 === myPubB64) {
      // Форсим немедленный broadcast при возврате в foreground — пиры увидят
      // «в сети» мгновенно, а не через остаток backoff-таймера.
      consecutiveHeartbeatFailures = 0;
      if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
      void tick();
    }
  });

  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  consecutiveHeartbeatFailures = 0;
  void tick();

  // Retry sweep: resubscribe failed peers + pick up newly-added contacts.
  if (retrySweepTimer) { clearInterval(retrySweepTimer); retrySweepTimer = null; }
  retrySweepTimer = setInterval(() => {
    void resubscribeFailed(myPubB64);
  }, RETRY_SWEEP_INTERVAL_MS);
}

export async function stopPresenceBroadcast(): Promise<void> {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (retrySweepTimer) {
    clearInterval(retrySweepTimer);
    retrySweepTimer = null;
  }
  if (appStateSub) {
    try { appStateSub.remove(); } catch { /* ignore */ }
    appStateSub = null;
  }
  consecutiveHeartbeatFailures = 0;
  for (const unsub of subscribedByPeer.values()) {
    try { unsub(); } catch { /* ignore */ }
  }
  subscribedByPeer.clear();
  failedPeers.clear();
  myPresencePubB64 = null;
  // v4.32.188 (Round-18 #3): clear module-scoped caches too, otherwise
  // after profile switch the new profile's UI reads prior profile's
  // lastSeen / custom-status entries for contacts that happen to exist
  // in both (or leaks that a peer was seen even though the new profile
  // has no contact with them).
  lastSeenCache.clear();
  peerStatusCache.clear();
  hiddenPeers.clear();
}

log.info('presence_service_loaded');
