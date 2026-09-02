/**
 * Доставка собственного профиля контактам: имя, фото, «О себе».
 *
 * v4.32.247. Раньше единственным путём был buildSignedProfile → IPFS: на
 * телефоне он всегда возвращал пустой CID, поэтому фото профиля и описание
 * никогда не покидали устройство владельца. Здесь профиль едет тем же
 * зашифрованным личным сообщением, что и переписка (см. profileEnvelope).
 *
 * Фото загружается зашифрованным вложением (`nb:`), как фотографии в чате:
 * ключ лежит внутри конверта, а конверт — внутри шифрования личного
 * сообщения, поэтому расшифровать вложение может только адресат.
 *
 * Кому уже отправлено — помнится в kv, чтобы открытие чата не превращалось в
 * повторную рассылку одного и того же.
 */
import { scopedKvGetFor, scopedKvSet, scopedKvSetFor } from '../storage/profileScopedKv';
import { getOwnDisplayNameFor, getOwnUsernameFor, ownFieldGetFor } from '../identity/ownProfile';
import { listContactsFor, setPeerProfileFor } from './contacts';
import { profileManager } from '../identity/profileManager';
import { mergeSentMap, parseSentMap, isSentVersion, trimSentMap } from './sentMap';
import { getMessagingService } from './messaging';
import { canReachPeer } from './sendGate';
import { avatarVisibilityFor, type AvatarVisibility } from '../settings/avatarVisibility';
import {
  PROFILE_PREFIX,
  encodeProfileEnvelope,
  decodeProfileEnvelope,
  normalizeOwnBio,
  type PeerProfileEnvelope,
} from './profileEnvelope';
import { ownBadgeGrantFor } from '../identity/ownBadge';
import { badgeFor } from '../identity/verification';
import { didFromPubB64 } from '../identity/did';
import { log } from '../logger';

export { PROFILE_PREFIX };

/**
 * Кому какая версия профиля уже отправлена: { pubB64: ts }.
 *
 * v4.32.325: своё у каждого аккаунта (scopedKvGet/Set) — как и остальные
 * ключи этого модуля. Это список открытых ключей собеседников, то есть граф
 * связей: общая запись смешивала адресатов разных аккаунтов и переживала
 * удаление профиля, доставаясь следующему с тем же номером.
 */
const SENT_KEY = 'profile:sent';
const SENT_MAX = 1000;
/** Что уже загружено вложением: { uri, cid, at }. */
const UPLOAD_KEY = 'profile:avatar_upload';
/** Когда профиль последний раз меняли — отметка версии, см. buildEnvelope. */
const CHANGED_AT_KEY = 'profile:changed_at';
/**
 * Ntfy хранит вложение около трёх часов (см. media/mediaBlob), поэтому ссылка
 * в конверте живёт недолго. Перед отправкой вложение перезаливается, если
 * прошлой загрузке больше двух часов, — адресат успевает скачать файл, пока
 * ссылка ещё рабочая. Тем, кто уже скачал, перезалив ничего не портит: файл
 * лежит в их кэше и повторно не запрашивается.
 */
const AVATAR_FRESH_MS = 2 * 60 * 60 * 1000;

type SentMap = Record<string, number>;

/** Готовый к отправке конверт вместе с ключом «эту версию уже отправляли». */
type Built = { env: PeerProfileEnvelope; version: number };

function activeProfileId(): number {
  return profileManager.getActiveProfile()?.id ?? 1;
}

async function loadSent(pid: number): Promise<SentMap> {
  return parseSentMap(await scopedKvGetFor(pid, SENT_KEY), isSentVersion);
}

/**
 * Очередь записей карты (v4.32.479).
 *
 * Рассылка и досылка при открытии чата ходят сюда одновременно, а между
 * чтением и записью у каждой — сеть. Правки применяются по одной и поверх
 * того, что лежит в базе на момент записи, иначе последний пришедший затирал
 * бы соседа своим снимком; см. sentMap.
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

/**
 * Локальный файл фото → `nb:`-дескриптор. В пределах двух часов используется
 * прошлая загрузка: без кэша каждое изменение имени перезаливало бы и фото.
 */
async function currentAvatarCid(pid: number, uri: string, now: number): Promise<string | null> {
  try {
    const raw = await scopedKvGetFor(pid, UPLOAD_KEY);
    if (raw) {
      const c = JSON.parse(raw) as { uri?: unknown; cid?: unknown; at?: unknown };
      if (
        c.uri === uri &&
        typeof c.cid === 'string' && c.cid &&
        typeof c.at === 'number' && now - c.at < AVATAR_FRESH_MS
      ) {
        return c.cid;
      }
    }
  } catch { /* кэш испорчен — просто зальём заново */ }

  try {
    const { uploadEncryptedBlob, makeNbCid } = await import('../media/mediaBlob');
    const { guessImageMime } = await import('../media/blobRef');
    // Тип берётся по расширению файла: у PNG с подписью image/jpeg получатель
    // сохранял бы фото под чужим расширением.
    const ref = await uploadEncryptedBlob(uri, guessImageMime(uri));
    if (!ref) return null;
    const cid = makeNbCid(ref);
    await scopedKvSetFor(pid, UPLOAD_KEY, JSON.stringify({ uri, cid, at: now }));
    return cid;
  } catch (e) {
    log.warn('profile_avatar_upload_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Собрать конверт из текущих настроек. `ts` — не «сейчас», а отметка
 * последнего изменения профиля: иначе каждая пересборка выглядела бы как
 * новая версия и рассылка шла бы по кругу.
 */
/**
 * v4.32.540: фотография профиля подчиняется отдельному решению человека.
 *
 * `audience` — кому этот конверт: `contacts` для рассылки по списку контактов,
 * `direct` для того, кто просто открыл переписку и в контактах может не
 * значиться. Настройка «кто видит фото» разбирается ЗДЕСЬ, на сборке, а не на
 * экране: конверт уезжает и из фоновых служб, и правило должно быть одним
 * куском кода на всех отправителей.
 *
 * `nobody` — фотография не покидает устройство совсем. `contacts` — уходит
 * только по списку контактов. `everybody` (по умолчанию, как было до этой
 * версии) — уходит всем, с кем идёт переписка.
 */
type Audience = 'contacts' | 'direct';

/** Есть ли собеседник в списке контактов этого профиля. Ошибку чтения списка
 *  трактуем как «нет»: показать фотографию тому, кому не положено, хуже, чем
 *  не показать её тому, кому положено, — второе чинится следующей рассылкой. */
async function isMyContact(pid: number, peerPubB64: string): Promise<boolean> {
  try {
    return (await listContactsFor(pid)).some((c) => c.peerPublicKey === peerPubB64);
  } catch (e) {
    log.warn('profile_contact_check_failed', { err: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

function avatarAllowed(visibility: AvatarVisibility, audience: Audience): boolean {
  if (visibility === 'nobody') return false;
  if (visibility === 'contacts') return audience === 'contacts';
  return true;
}

async function buildEnvelope(pid: number, audience: Audience = 'contacts'): Promise<Built | null> {
  const name = await getOwnDisplayNameFor(pid);
  const username = await getOwnUsernameFor(pid);
  // v4.32.378: тем же правилом, каким конверт чистится на сборке. Иначе
  // проверка «есть ли что рассылать» ниже считала «О себе» из одних невидимых
  // символов заполненным полем, и всем контактам уходил конверт, в котором
  // после чистки не оставалось ничего, кроме отметки времени.
  const bio = normalizeOwnBio(await ownFieldGetFor(pid, 'user_bio')) || null;
  const avatarUri = (await ownFieldGetFor(pid, 'user_avatar_uri'))?.trim() || '';
  if (!name && !username && !bio && !avatarUri) return null;
  const now = Date.now();
  let stamp = Number(await scopedKvGetFor(pid, CHANGED_AT_KEY)) || 0;
  if (!stamp) {
    // Первый запуск после обновления: профиль уже заполнен, но отметки нет.
    // Без записи ts был бы «сейчас» и менялся при каждом вызове — тогда любое
    // открытие чата выглядело бы как новая версия и рассылка шла бы по кругу.
    stamp = now;
    await scopedKvSetFor(pid, CHANGED_AT_KEY, String(stamp));
  }
  const shareAvatar = avatarAllowed(await avatarVisibilityFor(pid), audience);
  const avatarCid = avatarUri && shareAvatar ? await currentAvatarCid(pid, avatarUri, now) : null;
  // v4.32.547: бумага на галочку едет тем же конвертом, что и имя, — иначе ей
  // понадобился бы свой транспорт, а она нужна ровно там же и ровно тогда же.
  // Настройке «кто видит фото» она не подчиняется: галочка не про личное, она
  // существует, чтобы собеседник мог отличить настоящий аккаунт от похожего,
  // и спрятанная она бесполезна.
  const badge = await ownBadgeGrantFor(pid);
  return {
    env: { name, username, bio, avatarCid, badge, ts: stamp },
    version: versionOf(stamp, name, username, bio, shareAvatar ? avatarUri : '', avatarCid != null, badge),
  };
}

/**
 * Отметить, что профиль изменён. Вызывается редактором профиля перед
 * рассылкой: по этой отметке получатель отличает новую версию от старой.
 */
export async function markProfileChanged(): Promise<void> {
  await scopedKvSet(CHANGED_AT_KEY, String(Date.now()));
}

/**
 * Ключ версии: свёртка содержимого профиля, а не одно время правки.
 *
 * Считается по ФАЙЛУ фотографии, а не по `nb:`-дескриптору: дескриптор меняется
 * при каждом перезаливе (раз в два часа), и по нему рассылка уходила бы всем
 * контактам заново несколько раз в день, ничего нового им не сообщая. По одной
 * же отметке правки версия была бы слишком грубой: неудачная загрузка фото
 * считалась бы отправленной версией, и фотография не дошла бы никогда —
 * поэтому в свёртку входит и признак «фото удалось загрузить».
 */
function versionOf(
  ts: number,
  name: string | null,
  username: string | null,
  bio: string | null,
  avatarUri: string,
  avatarOk: boolean,
  badge: string | null
): number {
  // v4.32.547: бумага входит в свёртку. Без неё выданная галочка не уехала бы
  // никому: отметка правки профиля не менялась, версия совпадала с уже
  // отправленной, и рассылка честно пропускала каждый контакт.
  const src = `${ts}|${name ?? ''}|${username ?? ''}|${bio ?? ''}|${avatarUri}|${avatarOk ? '1' : '0'}|${badge ?? ''}`;
  // FNV-1a: нужен не криптостойкий хэш, а стабильное число для сравнения
  // «то же самое или уже другое» — обе стороны сравнения свои.
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Разослать профиль всем контактам, которые ещё не получили эту версию.
 * Вызывается после правки профиля и один раз при запуске.
 */
export async function broadcastMyProfile(): Promise<void> {
  const svc = getMessagingService();
  if (!svc) return;
  // v4.32.479: чей это профиль, решается ОДИН раз — здесь. Дальше рассылка
  // ждёт сеть на каждом собеседнике, и «активный» к её концу может означать
  // уже другой аккаунт.
  const pid = activeProfileId();
  const built = await buildEnvelope(pid);
  if (!built) return;
  const text = encodeProfileEnvelope(built.env);
  const { version } = built;

  let contacts: string[] = [];
  try {
    contacts = (await listContactsFor(pid)).map((c) => c.peerPublicKey);
  } catch (e) {
    log.warn('profile_contacts_failed', { err: e instanceof Error ? e.message : String(e) });
    return;
  }

  const sent = await loadSent(pid);
  const fresh: SentMap = {};
  for (const peer of contacts) {
    // Переключились на другой аккаунт — рассылка чужой карточки под чужой же
    // парой ключей не продолжается. Что успели отправить, записываем ниже.
    if (activeProfileId() !== pid) {
      log.info('profile_broadcast_profile_switched', { pid, done: Object.keys(fresh).length });
      break;
    }
    if (sent[peer] === version || fresh[peer] === version) continue;
    // v4.32.320: отказ отправки не записываем как доставку — иначе новое имя
    // и аватар не дойдут до этого собеседника уже никогда (до следующего
    // изменения профиля). См. sendGate.
    if (!(await canReachPeer(peer))) continue;
    try {
      await svc.sendMessage(peer, text);
      fresh[peer] = version;
    } catch (e) {
      log.debug('profile_send_failed', {
        to: peer.slice(0, 12),
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  await recordSent(pid, fresh);
  log.info('profile_broadcast', { contacts: contacts.length, version, sent: Object.keys(fresh).length });
}

/**
 * Отправить профиль конкретному собеседнику, если он этой версии ещё не
 * видел. Вызывается при открытии чата — так профиль доходит и до тех, кого
 * нет в контактах: рассылка их не охватывает.
 */
export async function syncMyProfileTo(peerPubB64: string): Promise<void> {
  if (!peerPubB64) return;
  const svc = getMessagingService();
  if (!svc) return;
  const pid = activeProfileId();
  // v4.32.540: этот путь охватывает и тех, кого нет в контактах, — значит для
  // настройки «фото видят только контакты» он и есть та граница, за которую
  // фотография не уходит. Но собеседник МОЖЕТ быть в контактах: тогда фото ему
  // положено, и «direct» здесь означало бы, что настройка прячет фото и от
  // тех, для кого её включали. Поэтому список читается — но только когда от
  // ответа что-то зависит.
  const audience: Audience =
    (await avatarVisibilityFor(pid)) === 'contacts' && !(await isMyContact(pid, peerPubB64))
      ? 'direct'
      : 'contacts';
  const built = await buildEnvelope(pid, audience);
  if (!built) return;
  const { version } = built;
  const sent = await loadSent(pid);
  if (sent[peerPubB64] === version) return;
  if (!(await canReachPeer(peerPubB64))) return;
  try {
    await svc.sendMessage(peerPubB64, encodeProfileEnvelope(built.env));
    await recordSent(pid, { [peerPubB64]: version });
  } catch (e) {
    log.debug('profile_sync_failed', {
      to: peerPubB64.slice(0, 12),
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Применить входящий профиль. Возвращает true, если конверт наш, — тогда
 * messaging не сохраняет его как обычное сообщение переписки.
 */
export async function handleIncomingPeerProfile(
  text: string,
  senderPubB64: string | undefined,
  ownerPid: number
): Promise<boolean> {
  if (!text.startsWith(PROFILE_PREFIX)) return false;
  const env = decodeProfileEnvelope(text, Date.now());
  if (!env || !senderPubB64) return true;
  // Профиль относится к ПОДПИСАННОМУ отправителю: поля «чей» в конверте нет
  // намеренно, иначе один контакт подменял бы фото другому.
  // v4.32.547: галочка проверяется ЗДЕСЬ, где известен отправитель, и только
  // здесь. Бумага связана с DID и с именем: сверяем её с ключом, которым
  // подписано это сообщение, и с тем именем, которое приехало этим же
  // конвертом. Не сойдётся — контакт запишется без галочки, а не с чужой.
  const verified = await badgeFor(env.badge, didFromPubB64(senderPubB64), env.username);
  try {
    await setPeerProfileFor(ownerPid, senderPubB64, { ...env, verified });
    log.info('profile_applied', { from: senderPubB64.slice(0, 12), verified: verified ?? '' });
  } catch (e) {
    log.warn('profile_apply_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  return true;
}
