/**
 * Черновик публикации в ленте: текст, фото, документы, гео-метка, опрос — всё
 * написанное человеком, но ещё не ставшее записью.
 *
 * Снимок нужен из-за picker'а: на Android система вправе убить активити, пока
 * пользователь выбирает фото, и React-state исчезает вместе с ней. Черновик
 * пишется перед запуском picker'а и поднимается при следующем mount'е — иначе
 * человек видит «опубликовал только текст, фото пропали» (v4.32.73).
 *
 * v4.32.292. Снимок жил прямо в экране ленты, и от этого две дыры:
 *
 * 1. Открытым текстом. Черновик переписки (`conversations.draft_text`),
 *    черновик группы (`groups.draft_text`) и отложенные сообщения (v4.32.283)
 *    лежат шифртекстом — это один класс данных и один ключ. Черновик
 *    публикации был единственным исключением: незаконченный пост целиком, с
 *    текстом, путями к фото и гео-меткой, лежал в kv читаемым.
 * 2. Ключ `feed_compose_pending:<did>` — без namespace профиля. Удаление
 *    профиля сметает `p<id>:%`, а этот ключ под правило не подпадал: текст
 *    удалённого аккаунта оставался в базе навсегда.
 *
 * Заодно разбор снимка переехал сюда целиком. В экране проверялись не все
 * поля: `pollQuestion` и `pollOptions` брались как есть, и подменённая запись
 * kv разворачивалась в сотню полей ввода (uris/pickedDocs/draft ограничили в
 * v4.32.194, про опрос забыли).
 */
import { profileManager } from '../identity/profileManager';
import { log } from '../logger';
import { profileScopedKey } from '../storage/kvKeys';
import { kvDelete, kvGet, kvGetSecret, kvSetSecret } from '../storage/local';

/**
 * Сколько фото можно приложить к публикации. Ограничение продуктовое: столько
 * же в Telegram/WhatsApp/Instagram, дальше лента перестаёт читаться. Живёт
 * рядом со снимком черновика, потому что снимок эти же пути и хранит — иначе
 * ограничение пришлось бы писать дважды и следить, чтобы копии не разошлись.
 */
export const FEED_MAX_IMAGES = 10;
/** Документов к публикации — столько же, сколько принимает picker. */
export const FEED_MAX_DOCS = 3;
/**
 * Предельный размер одного документа. Ограничение не продуктовое, а
 * техническое: документ едет внутри конверта публикации, а конверт уходит
 * broadcast'ом всем контактам и целиком должен уложиться в 2 МБ.
 */
export const FEED_MAX_DOC_BYTES = Math.round(1.2 * 1024 * 1024);
/** Вариантов в опросе: меньше двух опрос не имеет смысла, больше четырёх не даёт интерфейс. */
export const FEED_POLL_MIN_OPTIONS = 2;
export const FEED_POLL_MAX_OPTIONS = 4;
/** Черновик старше получаса не восстанавливаем: человек давно ушёл из composer'а. */
export const COMPOSE_DRAFT_TTL_MS = 30 * 60 * 1000;

const MAX_TEXT = 8192;
const MAX_SHORT_TEXT = 512;
const MAX_URI = 2048;

export type ComposeDraftDoc = { uri: string; name: string; mime: string; size?: number };

export type ComposeDraft = {
  draft: string;
  uris: string[];
  pickedDocs: ComposeDraftDoc[];
  postLocationTag: string | null;
  isPollMode: boolean;
  pollQuestion: string;
  pollOptions: string[];
  /** Какую запись человек правил, когда его прервали. См. planComposeRestore. */
  editingPostId: string | null;
};

/**
 * Что делать с восстановленным черновиком (v4.32.333).
 *
 * Правило одно, и оно про безопасность, а не про удобство: правка НИКОГДА не
 * должна превратиться в публикацию. До этой версии editingPostId сохранялся, но
 * не применялся — композер открывался как «Новая публикация», и кнопка
 * «Сохранить» становилась «Опубликовать». Человек, которого прервали посреди
 * правки, нажимал её и рассылал всем контактам ВТОРУЮ запись, а исходная
 * оставалась на месте.
 *
 * Если правленой записи больше нет, черновик выбрасывается. Открыть его как
 * новую публикацию — то же самое разослать не спрошенное; текст правки дороже
 * не стоит.
 */
export type ComposeRestorePlan =
  | { kind: 'new' }
  | { kind: 'edit'; postId: string }
  | { kind: 'discard'; reason: 'edit_target_gone' };

export function planComposeRestore(input: {
  editingPostId: string | null;
  /** Нашлась ли правленая запись. false и при «нет», и при «не прочиталась». */
  editTargetExists: boolean;
}): ComposeRestorePlan {
  if (!input.editingPostId) return { kind: 'new' };
  if (!input.editTargetExists) return { kind: 'discard', reason: 'edit_target_gone' };
  return { kind: 'edit', postId: input.editingPostId };
}

const COMPOSE_DRAFT_KEY = 'feed_compose_pending';

/** Ключ до v4.32.292: по did и открытым текстом. */
function legacyComposeDraftKey(did: string): string {
  return `${COMPOSE_DRAFT_KEY}:${did}`;
}

/**
 * Номер профиля по его did. Активный проверяется первым — это обычный путь и
 * он отвечает из кэша; полный список разворачивает ключи всех профилей.
 * `null` — did не принадлежит ни одному профилю на устройстве (profileManager
 * ещё не поднялся): писать такой черновик некуда, и подставлять первый профиль
 * нельзя — это как раз и складывало бы данные разных аккаунтов в одно место.
 */
function ownerProfileId(did: string): number | null {
  if (!did) return null;
  const active = profileManager.getActiveProfile();
  if (active?.did === did) return active.id;
  return profileManager.getAllProfiles().find((p) => p.did === did)?.id ?? null;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function strList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    out.push(item.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function docList(v: unknown): ComposeDraftDoc[] {
  if (!Array.isArray(v)) return [];
  const out: ComposeDraftDoc[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const d = item as Record<string, unknown>;
    if (typeof d.uri !== 'string') continue;
    out.push({
      uri: d.uri.slice(0, MAX_URI),
      name: str(d.name, MAX_SHORT_TEXT),
      mime: str(d.mime, MAX_SHORT_TEXT),
      ...(typeof d.size === 'number' && Number.isFinite(d.size) ? { size: d.size } : {}),
    });
    if (out.length >= FEED_MAX_DOCS) break;
  }
  return out;
}

/**
 * Что вышло из выбора документов: что прикрепляем и что не взяли — по каждой
 * причине отдельно, чтобы человеку было что сказать.
 */
export type ComposeDocSelection = {
  picked: ComposeDraftDoc[];
  /** Отброшено по размеру. */
  tooBig: number;
  /** Отброшено потому, что свободных мест уже не осталось. */
  noRoom: number;
};

/**
 * Отобрать документы из ответа picker'а (v4.32.321).
 *
 * Раньше отбор был записан прямо в экране: предел размера и предел количества
 * стояли там числами, хотя `FEED_MAX_DOCS` уже жил здесь — рядом со снимком,
 * который эти же документы и хранит. Хуже того, лишние сверх предела экран
 * молча срезал `slice(0, 3)`: выбрал пять файлов — три прикрепились, два
 * исчезли без объяснений. Теперь причина отказа возвращается вызывающему.
 *
 * Значения полей режутся по тем же границам, что и при восстановлении снимка:
 * иначе длинное имя файла жило бы в интерфейсе целиком, а после восстановления
 * черновика вдруг становилось короче.
 */
export function selectComposeDocs(assets: unknown, attachedCount: number): ComposeDocSelection {
  const room = Math.max(0, FEED_MAX_DOCS - Math.max(0, attachedCount));
  const picked: ComposeDraftDoc[] = [];
  let tooBig = 0;
  let noRoom = 0;
  if (!Array.isArray(assets)) return { picked, tooBig, noRoom };
  for (const item of assets) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const a = item as Record<string, unknown>;
    if (typeof a.uri !== 'string' || !a.uri) continue;
    const size = typeof a.size === 'number' && Number.isFinite(a.size) && a.size > 0 ? a.size : 0;
    if (size > FEED_MAX_DOC_BYTES) { tooBig += 1; continue; }
    if (picked.length >= room) { noRoom += 1; continue; }
    picked.push({
      uri: a.uri.slice(0, MAX_URI),
      name: str(a.name, MAX_SHORT_TEXT) || 'document',
      mime: str(a.mimeType, MAX_SHORT_TEXT) || 'application/octet-stream',
      size,
    });
  }
  return { picked, tooBig, noRoom };
}

/**
 * Разбор записи kv в снимок. Значение может быть повреждено или подменено —
 * вызывающий получает либо нормализованный снимок в границах интерфейса, либо
 * `null` (нечего восстанавливать / протухло).
 */
export function parseComposeDraft(raw: string | null, now: number): ComposeDraft | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const snap = parsed as Record<string, unknown>;
  const ts = typeof snap.ts === 'number' && Number.isFinite(snap.ts) ? snap.ts : 0;
  if (!ts || now - ts > COMPOSE_DRAFT_TTL_MS) return null;
  const pollOptions = strList(snap.pollOptions, FEED_POLL_MAX_OPTIONS, MAX_SHORT_TEXT);
  while (pollOptions.length < FEED_POLL_MIN_OPTIONS) pollOptions.push('');
  return {
    draft: str(snap.draft, MAX_TEXT),
    uris: strList(snap.uris, FEED_MAX_IMAGES, MAX_URI),
    pickedDocs: docList(snap.pickedDocs),
    postLocationTag: typeof snap.postLocationTag === 'string' ? snap.postLocationTag.slice(0, MAX_SHORT_TEXT) : null,
    isPollMode: snap.isPollMode === true,
    pollQuestion: str(snap.pollQuestion, MAX_SHORT_TEXT),
    pollOptions,
    editingPostId: typeof snap.editingPostId === 'string' ? snap.editingPostId.slice(0, MAX_SHORT_TEXT) : null,
  };
}

/**
 * Поднять черновик. Восстановление одноразовое, но запись стирает экран —
 * после того, как применил снимок: между чтением и применением ещё ждём
 * результат picker'а, и умри активити там, стирать было бы нечего и незачем.
 * Мусор и протухшее убираются здесь же — их применять некому.
 */
export async function loadComposeDraft(did: string): Promise<ComposeDraft | null> {
  try {
    const pid = ownerProfileId(did);
    let raw = pid == null ? null : await kvGetSecret(profileScopedKey(pid, COMPOSE_DRAFT_KEY));
    // Запись от версий до v4.32.292: открытым текстом и с did в ключе. Стираем
    // её всегда, даже если поднимать нечего — иначе она так и останется
    // читаемой, а удаление профиля её не заберёт.
    const legacyKey = legacyComposeDraftKey(did);
    const legacyRaw = await kvGet(legacyKey);
    if (legacyRaw != null) {
      await kvDelete(legacyKey);
      if (raw == null) raw = legacyRaw;
    }
    const snap = parseComposeDraft(raw, Date.now());
    if (!snap && raw != null) await clearComposeDraft(did);
    return snap;
  } catch (e) {
    log.warn('compose_draft_load_failed', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function saveComposeDraft(did: string, snap: ComposeDraft): Promise<void> {
  try {
    const pid = ownerProfileId(did);
    if (pid == null) {
      log.warn('compose_draft_no_owner', { didLen: did.length });
      return;
    }
    await kvSetSecret(
      profileScopedKey(pid, COMPOSE_DRAFT_KEY),
      JSON.stringify({ ...snap, ts: Date.now() })
    );
  } catch (e) {
    log.warn('compose_draft_save_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

export async function clearComposeDraft(did: string): Promise<void> {
  try {
    const pid = ownerProfileId(did);
    if (pid != null) await kvDelete(profileScopedKey(pid, COMPOSE_DRAFT_KEY));
  } catch (e) {
    log.warn('compose_draft_clear_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Убрать черновик удаляемого профиля, записанный до v4.32.292: ключ с did под
 * `p<id>:%` не подпадает, и без этого текст удалённого аккаунта пережил бы сам
 * аккаунт. Свой ключ профиля сметает общая уборка в deleteProfileDataFromLocalDb.
 */
export async function deleteLegacyComposeDraft(did: string): Promise<void> {
  try {
    await kvDelete(legacyComposeDraftKey(did));
  } catch (e) {
    log.warn('compose_draft_legacy_delete_failed', { err: e instanceof Error ? e.message : String(e) });
  }
}
