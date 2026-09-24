/**
 * storyService — публикация и получение Stories (эфемерных сторис, 24ч).
 *
 * Протокол:
 * - Медиа уходит зашифрованным вложением (nb:), а при включённом IPFS — в IPFS.
 * - JSON-конверт (см. storyEnvelope) рассылается каждому контакту обычным
 *   зашифрованным личным сообщением с управляющим префиксом; получатель
 *   применяет его через handleIncomingStory и в переписке его не видит.
 * - Сторис истекают через 24 часа (expiresAt).
 *
 * v4.32.246: раньше конверт публиковался в pubsub-топик
 * "/airchat/v1/stories/<contactPubB64>", а pubsub работает поверх IPFS,
 * выключенного на телефоне с v4.32.19. Опубликованная сторис не уходила
 * никуда, а чужие не приходили никогда: pubsubSubscribe сразу возвращал null.
 * Топик оставался дополнением к личным сообщениям.
 *
 * v4.32.615: топик убран с обеих сторон.
 *
 * Отправка. В топик уходил `JSON.stringify(envelope)` — открытым текстом, без
 * подписи и без шифрования, а имя топика выводится из публичного ключа
 * получателя, то есть известно кому угодно. На телефоне это был холостой
 * вызов (IPFS выключен), а в вебе — рассылка своих сторис всем желающим.
 *
 * Приём. Проверка «автор в контактах» тут ничего не доказывает: в топик пишет
 * любой участник pubsub, а `authorPubB64` берётся из самого конверта. Зная мой
 * публичный ключ и ключ любого моего контакта — оба не секрет, — посторонний
 * клал в мою ленту сторис от его имени. Мимо блок-листа тоже: проверку
 * v4.32.491 («не класть сторис заблокированного в мою ленту») этот путь
 * обходил целиком.
 *
 * Личные сообщения делают всё то же самое и делают это честно: конверт
 * зашифрован получателю, отправитель известен из DM-слоя, авторство сверяется
 * (handleIncomingStory), блокировка соблюдается. Второго пути не нужно.
 */

import { v4 as uuidv4 } from 'uuid';
import type { KeyPairBytes } from '../crypto/keyManager';
import { publicKeyToDidKey } from '../identity/did';
import { ownerPidForPublicKey } from '../identity/ownerPidLookup';
import { listContactsFor, listContactsReadDetailed } from './contacts';
import { catFromIpfs } from '../transport/ipfs/node';
import { insertStory, deleteExpiredStories, countActiveStoriesByAuthor, STORY_TTL_MS } from '../storage/local';
import { decodeStoryEnvelope, encodeStoryEnvelope, type StoryEnvelope } from './storyEnvelope';
import { isNbCid, parseNbCid, resolveBlobToLocalFile } from '../media/mediaBlob';
import { uploadMediaToCid } from '../media/mediaUpload';
import { IPFS_VIDEO_MAX_BYTES } from '../media/uploadRoute';
import type { StoryMediaFailure, StoryPublishOutcome } from './storyPublishOutcome';
import { rateLimiter } from '../security/rateLimiter';
import type { EnvelopeIntake } from '../transport/envelopeIntake';
import { log } from '../logger';

/**
 * Потолок одновременно живых сторис от одного автора.
 *
 * v4.32.248: своих ограничений у приёма не было вовсе — сколько конвертов
 * контакт прислал, столько строк в базе и столько загрузок вложений (каждое
 * до 8 МБ) получатель и делал, ничего для этого не нажимая. Тридцать штук за
 * сутки жизни сторис — заведомо больше, чем публикует живой человек.
 */
const STORY_MAX_PER_AUTHOR = 30;

/**
 * Идентификатор строки для ЧУЖОЙ сторис.
 *
 * v4.32.248: id приходит из конверта, а вставка идёт INSERT OR IGNORE — то
 * есть первый пришедший занимает id навсегда. Контакт, получивший чужую
 * сторис, знал её id и мог тут же прислать свою с тем же id: у общего
 * знакомого настоящая сторис молча пропадала, а на её месте оказывалась
 * подставленная. Приписанный ключ автора делает столкновение невозможным.
 *
 * Идентификатор используется только на устройстве (отметка о просмотре и
 * удаление своей сторис) и наружу в таком виде не уходит.
 */
function localStoryId(authorPubB64: string, envelopeId: string): string {
  return `${authorPubB64}:${envelopeId}`;
}

// ─── Story update event bus ───────────────────────────────────────────────────
const storyListeners = new Set<() => void>();

export function subscribeStoryUpdates(cb: () => void): () => void {
  storyListeners.add(cb);
  return () => storyListeners.delete(cb);
}

function notifyStoryListeners(): void {
  storyListeners.forEach((cb) => cb());
}

/**
 * Результат публикации.
 *
 * v4.32.360: раньше о медиа сообщал один `mediaFailed: boolean`, и экран
 * объяснял любую неудачу одинаково — «слишком большое, предел 8 МБ».
 * Оборванная загрузка выглядела как превышение размера, а сам предел зависит
 * от того, включён ли IPFS, и восемью мегабайтами не исчерпывается.
 *
 * `delivered`/`contacts` — сколько контактов получило конверт. Ноль при
 * непустом списке означает, что сторис осталась только на устройстве: строка
 * в базе создаётся до рассылки, поэтому автору она видна в любом случае.
 */
export type PublishStoryResult = StoryPublishOutcome & { storyId: string };

/** Encode a story envelope and broadcast to all contacts. */
export async function publishStory(
  pair: KeyPairBytes,
  mediaUri: string | null,
  text: string | null,
  mediaType: 'image' | 'video' = 'image'
): Promise<PublishStoryResult> {
  const myPubB64 = Buffer.from(pair.publicKey).toString('base64');
  const myDid = publicKeyToDidKey(pair.publicKey);
  const pid = ownerPidForPublicKey(pair.publicKey);
  const now = Date.now();

  // Медиа: общий путь загрузки — IPFS, если он включён, иначе зашифрованное
  // вложение.
  //
  // v4.32.360: здесь файл читался целиком в base64 БЕЗ единой проверки
  // размера, и только потом отдавался в addToIpfs — на телефоне тот всегда
  // возвращает null, после чего uploadEncryptedBlob читал тот же файл второй
  // раз. Минутное видео с камеры — это сотня мегабайт, а чтение в base64
  // стоит втрое больше самого файла: приложение падало по памяти ещё до
  // того, как хоть кто-то сравнил размер с пределом.
  let mediaCid: string | null = null;
  let mediaFailure: StoryMediaFailure | null = null;
  if (mediaUri) {
    const up = await uploadMediaToCid(mediaUri, {
      mime: mediaType === 'video' ? 'video/mp4' : 'image/jpeg',
      ipfsMaxBytes: mediaType === 'video' ? IPFS_VIDEO_MAX_BYTES : undefined,
    });
    if (up.ok) mediaCid = up.cid;
    else {
      mediaFailure = { reason: up.reason, limitBytes: up.limitBytes };
      log.warn('story_media_upload_failed', { reason: up.reason, limit: up.limitBytes });
    }
  }

  const storyId = uuidv4();
  const envelope: StoryEnvelope = {
    id: storyId,
    authorPubB64: myPubB64,
    authorDid: myDid,
    mediaCid,
    mediaType,
    text,
    expiresAt: now + STORY_TTL_MS,
    createdAt: now,
  };

  // Save locally
  await insertStory({
    id: storyId,
    authorPubB64: myPubB64,
    mediaUri,
    mediaType,
    text,
    expiresAt: now + STORY_TTL_MS,
    viewedBy: null,
    ownerProfileId: pid,
    createdAt: now,
  });

  // Рассылка контактам. Основной путь — личное сообщение с управляющим
  // префиксом: он шифруется и доезжает через тот же транспорт, что переписка.
  //
  // v4.32.615: заблокированные отсеиваются здесь, а не внутри sendMessage.
  // Там отказ по блокировке поднимает баннер «Контакт заблокирован» — на
  // публикации сторис автор получал по такому баннеру за каждого, кого сам же
  // и заблокировал, ни одному человеку при этом ничего не написав. Ещё
  // блокировка — не сбой связи: если все получатели заблокированы, список
  // рассылки пуст, и говорить «сторис не ушла ни одному контакту» не о чем.
  await rateLimiter.whenReady();
  // v4.32.724: чтение различающее. Сорванное чтение справочника приходило сюда
  // пустым списком — тем же, что и «контактов нет», — и дальше всё сходилось
  // одно к одному: рассылать некому, delivered ноль, contacts ноль, а по этим
  // двум нулям экран решает, что сторис локальная и говорить не о чем. Автор
  // видел свою сторис на месте (строка в базе создаётся до рассылки) и не
  // узнавал, что её не получил никто.
  const contactsRead = await listContactsReadDetailed(pid);
  const contacts = (contactsRead?.contacts ?? []).filter(
    (c) => !rateLimiter.isBlocked(c.peerPublicKey),
  );
  const text2 = encodeStoryEnvelope(envelope);
  const { getMessagingService } = await import('./messaging');
  const svc = getMessagingService();
  let delivered = 0;
  await Promise.allSettled(
    contacts.map(async (c) => {
      try {
        // v4.32.615: отказ у sendMessage — это null, а не исключение (часовой
        // лимит, отсутствие ключа). Считая попытку доставкой, мы гасили
        // единственное предупреждение автору: `delivered > 0`.
        if (svc && (await svc.sendMessage(c.peerPublicKey, text2))) {
          delivered += 1;
        }
      } catch (e) {
        log.debug('story_send_failed', { contact: c.peerPublicKey.slice(0, 8) });
      }
    })
  );

  log.info('story_published', {
    storyId: storyId.slice(0, 8),
    contacts: contacts.length,
    delivered,
    contactsUnreadable: contactsRead === null,
    contactsMissing: contactsRead?.missing ?? 0,
  });
  notifyStoryListeners();
  return {
    storyId,
    mediaFailure,
    contacts: contacts.length,
    delivered,
    contactsUnreadable: contactsRead === null,
    // v4.32.846: часть справочника не открылась. Сторис ушла тем, кого назвали,
    // и молчать об остальных нельзя: повтора у сторис нет вовсе.
    contactsMissing: contactsRead?.missing ?? 0,
  };
}

/**
 * Исход попытки достать медиа сторис (v4.32.820).
 *
 * Два отказа из трёх исходов, и путать их нельзя: «сейчас не достали» проходит
 * само при следующей попытке, «не возьмём никогда» — не пройдёт ни с какого
 * раза. Приёму конверта это и есть разница между «подождать» и «записать как
 * есть»; см. applyIncomingStory.
 */
export type StoryMediaRead =
  /** Адрес, готовый к показу. */
  | { state: 'ready'; uri: string }
  /** Не достали: оффлайн, relay молчит, вложение ещё не доехало. */
  | { state: 'unavailable' }
  /** Не возьмём: ссылка битая или медиа больше потолка. */
  | { state: 'rejected' };

/**
 * Скачать медиа сторис и назвать исход словом.
 *
 * Два источника: зашифрованное вложение (`nb:`) — расшифровывается в файл
 * кэша; обычный CID — читается из IPFS и кладётся в data:-адрес.
 *
 * v4.32.820: раньше и то и другое отвечало `null`, и приём не мог отличить
 * «связи нет» от «этого медиа не будет никогда».
 */
export async function resolveStoryMediaRead(
  mediaCid: string,
  mediaType: 'image' | 'video'
): Promise<StoryMediaRead> {
  if (isNbCid(mediaCid)) {
    const ref = parseNbCid(mediaCid);
    // Ссылка не разобралась — чинить нечего: она такой и приехала.
    if (!ref) return { state: 'rejected' };
    // Файл кэша, а не data:-строка: видео сторис в base64 внутри SQLite —
    // десятки мегабайт в строке, на слабом устройстве это заметная пауза.
    let uri: string | null = null;
    try {
      uri = await resolveBlobToLocalFile(ref, mediaType === 'video' ? 'mp4' : 'jpg');
    } catch (e) {
      log.warn('story_media_blob_failed', { err: e instanceof Error ? e.message : String(e) });
    }
    // Любой отказ скачивания собран там в `null`: и оффлайн, и промах по
    // relay. Порода у них одна — «сейчас нет», — поэтому здесь они и не
    // разделяются.
    return uri ? { state: 'ready', uri } : { state: 'unavailable' };
  }
  let bytes: Uint8Array | null = null;
  try {
    bytes = await catFromIpfs(mediaCid);
  } catch (e) {
    log.warn('story_media_ipfs_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  if (!bytes) return { state: 'unavailable' };
  // Потолок распакованного медиа: контакт может выложить в IPFS сотни
  // мегабайт и прислать CID — base64 в SQLite подвесил бы JS-поток.
  const max = mediaType === 'video' ? 40 * 1024 * 1024 : 10 * 1024 * 1024;
  if (bytes.byteLength > max) {
    log.warn('story_media_oversize_drop', { cid: mediaCid.slice(0, 12), bytes: bytes.byteLength });
    return { state: 'rejected' };
  }
  const b64 = Buffer.from(bytes).toString('base64');
  return { state: 'ready', uri: `data:${mediaType === 'video' ? 'video/mp4' : 'image/jpeg'};base64,${b64}` };
}

/**
 * Тот же поход за медиа для показа на экране: там разницы между двумя
 * отказами нет — плитку либо есть чем нарисовать, либо нет.
 */
export async function resolveStoryMedia(mediaCid: string, mediaType: 'image' | 'video'): Promise<string | null> {
  const read = await resolveStoryMediaRead(mediaCid, mediaType);
  return read.state === 'ready' ? read.uri : null;
}

/**
 * Общая часть приёма: проверка автора, скачивание медиа, запись в базу.
 * Конверт к этому моменту уже разобран и проверен по форме.
 *
 * v4.32.760: отвечает словом, а не `void`. Отказы здесь двух разных пород, и
 * раньше они были неразличимы — оба означали «дальше не идём», а кадр при этом
 * объявлялся разобранным. Не в контактах и «у автора уже полсотни» — решения
 * окончательные, повтор их не изменит. А вот «список контактов не прочитался»
 * и «счётчик не прочитался» — это занятая на секунду база, и она стоила
 * сторис целиком: второй раз её не пришлют.
 */
async function applyIncomingStory(envelope: StoryEnvelope, pid: number): Promise<EnvelopeIntake> {
  // Автор обязан быть в контактах: свои сторис пишутся напрямую в publishStory,
  // поэтому здесь остаются только чужие, и незнакомец ничего не подсунет.
  //
  // v4.32.361: обе проверки ниже раньше глотали свою ошибку и пропускали
  // конверт дальше — «не повод терять сторис». Разрешение по умолчанию: DM
  // приходит от кого угодно, знающего наш ключ, и единственное, что отделяет
  // ленту сторис от чужих картинок, — этот список контактов. Сбой чтения базы
  // делал ленту открытой, а следом та же база принимала запись — то есть
  // «не прочиталось» и «нечем сохранять» происходят вместе. Теперь конверт
  // отбрасывается: сторис живёт сутки, контакт публикует их пачками, и потеря
  // одной стоит несравнимо меньше принятой чужой.
  try {
    const contacts = await listContactsFor(pid);
    if (!contacts.some((c) => c.peerPublicKey === envelope.authorPubB64)) {
      log.debug('story_author_not_in_contacts_drop', { author: envelope.authorPubB64.slice(0, 8) });
      return 'consumed';
    }
  } catch (e) {
    // v4.32.760: «не прочиталось» — не «не в контактах». Ленту это по-прежнему
    // не открывает: пока список недоступен, ничего не пишется.
    log.warn('story_contacts_unreadable_defer', { err: e instanceof Error ? e.message : String(e) });
    return 'deferred';
  }

  // Потолок проверяется ДО скачивания медиа: именно загрузка вложения, а не
  // строка в базе, стоит дорого.
  try {
    const already = await countActiveStoriesByAuthor(envelope.authorPubB64, pid);
    if (already >= STORY_MAX_PER_AUTHOR) {
      log.warn('story_author_limit_drop', {
        author: envelope.authorPubB64.slice(0, 8),
        active: already,
      });
      return 'consumed';
    }
  } catch (e) {
    log.warn('story_count_unreadable_defer', { err: e instanceof Error ? e.message : String(e) });
    return 'deferred';
  }

  // Медиа скачивается СРАЗУ, а не при открытии сторис, и это не оплошность:
  // сторис живёт сутки, а вложение на relay — около трёх часов (см. mediaBlob).
  // Отложенная загрузка означала бы, что открытая вечером сторис пустая.
  let mediaUri: string | null = null;
  if (envelope.mediaCid) {
    const read = await resolveStoryMediaRead(envelope.mediaCid, envelope.mediaType);
    /**
     * v4.32.820: не достали медиа — кадр откладывается, а не записывается
     * текстом.
     *
     * Прежде любой отказ скачивания молча оставлял `mediaUri` пустым, и сторис
     * записывалась НАВСЕГДА без снимка: строка есть, повтора у конверта нет,
     * второй раз её не пришлют. Оффлайн в минуту приёма — обычное дело, а
     * итог его был неотличим от «друг выложил пустую карточку». Ровно то, от
     * чего уходили, когда скачивание сделали немедленным (см. выше).
     *
     * Ждать тут безопасно и недолго: кадр лежит на relay, а сама сторис живёт
     * сутки — просроченный конверт decodeStoryEnvelope уже не принимает, и
     * откладывание кончается вместе с ней, а не висит тридцать суток.
     *
     * 'rejected' откладывать нельзя: битая ссылка и медиа больше потолка
     * такими и останутся, а каждая попытка — это повторное скачивание. Такую
     * сторис записываем как есть: текст в ней может быть всем содержанием.
     */
    if (read.state === 'unavailable') {
      log.warn('story_media_unavailable_defer', {
        author: envelope.authorPubB64.slice(0, 8),
        cid: envelope.mediaCid.slice(0, 12),
      });
      return 'deferred';
    }
    if (read.state === 'rejected') {
      log.warn('story_media_rejected_text_only', {
        author: envelope.authorPubB64.slice(0, 8),
        cid: envelope.mediaCid.slice(0, 12),
      });
    } else {
      mediaUri = read.uri;
    }
  }

  try {
    // Запись идёт по имени, собранному из ключа автора и номера конверта, а
    // сама строка — INSERT OR IGNORE: повторное применение того же конверта
    // второй сторис не заводит.
    await insertStory({
      id: localStoryId(envelope.authorPubB64, envelope.id),
      authorPubB64: envelope.authorPubB64,
      mediaUri,
      mediaType: envelope.mediaType,
      text: envelope.text,
      expiresAt: envelope.expiresAt,
      viewedBy: null,
      ownerProfileId: pid,
      createdAt: envelope.createdAt,
    });
  } catch (e) {
    log.warn('story_insert_failed_defer', { err: e instanceof Error ? e.message : String(e) });
    return 'deferred';
  }

  // Уборка просроченных и оповещение экрана к самой сторис не относятся: она
  // уже записана, и откладывать кадр из-за них значило бы скачивать медиа
  // второй раз ради того, что произойдёт при следующем приёме само.
  try {
    await deleteExpiredStories(pid);
  } catch (e) {
    log.warn('story_expire_sweep_failed', { err: e instanceof Error ? e.message : String(e) });
  }
  notifyStoryListeners();
  log.info('story_received', { from: envelope.authorPubB64.slice(0, 8) });
  return 'consumed';
}

/**
 * Входящая сторис личным сообщением.
 *
 * Отправитель проверяется по DM-слою: конверт с чужим authorPubB64 не
 * принимается, иначе контакт публиковал бы сторис от имени другого контакта.
 *
 * v4.32.760: отвечает словом, а не `true`. Прежний `boolean` значил «конверт
 * наш», и вызывающим он не читался вовсе: ветка в messaging.ts объявляла кадр
 * разобранным в любом исходе. «Разобрано» двигает метку докуда прочитано, а
 * relay отдаёт накопленное только по ней — секунда занятой базы стоила сторис
 * навсегда, и повтора у неё нет.
 *
 * Отсрочка тут дороже, чем у настроек: разобрать кадр второй раз значит ещё
 * раз скачать вложение. Поэтому откладываем только занятую базу — мусор вместо
 * конверта, подставленный автор, незнакомец и упёршийся потолок годными не
 * станут ни с какого раза.
 *
 * v4.32.820: и не скачавшееся медиа. Дороговизна повтора тут ни при чём —
 * скачать как раз и не вышло, а записанная без снимка сторис не чинится уже
 * ничем.
 */
export async function handleIncomingStory(
  text: string,
  senderPubB64: string,
  ownerPid: number
): Promise<EnvelopeIntake> {
  const envelope = decodeStoryEnvelope(text, Date.now());
  if (!envelope) return 'consumed';
  if (envelope.authorPubB64 !== senderPubB64) {
    log.warn('story_author_mismatch_drop', { from: senderPubB64.slice(0, 8), claimed: envelope.authorPubB64.slice(0, 8) });
    return 'consumed';
  }
  try {
    return await applyIncomingStory(envelope, ownerPid);
  } catch (e) {
    // Сюда доходит только то, что не поймано внутри: медиа и запись строки
    // разобраны там поимённо. Считаем такое занятой базой — один повтор
    // ограничен сверху (см. internetCoordinator).
    log.warn('story_apply_failed', { err: e instanceof Error ? e.message : String(e) });
    return 'deferred';
  }
}

