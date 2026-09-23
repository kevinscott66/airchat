/**
 * Что headless-ядро умеет честно — и ничего сверх этого.
 *
 * Здесь нет описаний протокола MCP и нет схем: только вызовы ядра и перевод
 * его ответов на язык, понятный тому, кто ядра не видит. Схемы и транспорт —
 * в `server.ts`, и разделение не косметическое: этот файл проверяется
 * сценарием напрямую, без клиента и без сокета.
 *
 * ─── Правило, которому подчинён весь файл ───────────────────────────────────
 *
 * Отказ остаётся отказом. У ядра есть три разных «ничего»:
 *
 *   `null` от чтения    — прочитать НЕ УДАЛОСЬ. Это не пустой список. Агент,
 *                         получивший на такое `[]`, сделает вывод «контактов
 *                         нет» и может, например, никому не ответить.
 *   `[]`                — действительно пусто.
 *   `null` от отправки  — не отправлено, и причин четыре (блокировка, часовой
 *                         лимит, нет общего ключа, некуда отправить). Они
 *                         требуют разных действий, поэтому сводить их к
 *                         «не получилось» нельзя.
 *
 * Причины отправки ядро не возвращает — оно их пишет в журнал. Мы их оттуда
 * читаем (см. `runtime/logBus`), а не выдумываем: если в журнале не нашлось
 * знакомого имени, так и сказано — `unknown`, вместе с самими строками.
 *
 * ─── Почему отправка стоит в очереди ────────────────────────────────────────
 *
 * Журнал общий на процесс. Две одновременные отправки перемешали бы свои
 * строки, и причина отказа одной приписалась бы другой — то есть агент
 * получил бы уверенно названную неправду. Очередь стоит дешевле: отправок
 * здесь единицы в минуту, а не тысячи.
 */
import {
  addContact,
  listContactsRead,
  parseContactId,
  BAD_PUBLIC_KEY_MESSAGE,
  CONTACT_ROW_UNREADABLE_MESSAGE,
  CONTACT_ROW_WRITE_FAILED_MESSAGE,
  type Contact,
} from '../../src/core/social/contacts';
import { getMessagingService } from '../../src/core/social/messaging';
import { listConversationsRead, type ChatMessageRow } from '../../src/core/storage/local';
import { isValidCursor, type ChatPageCursor } from '../../src/core/storage/chatPageCursor';
import { getInternetTransportSingleton } from '../../src/core/transport/internet/internetTransport';
import { publicKeyToDidKey, didFromPubB64 } from '../../src/core/identity/did';
import { profileManager } from '../../src/core/identity/profileManager';
import {
  ownFieldSet,
  ownFieldTryGetFor,
  sanitizeOwnDisplayName,
  OWN_DISPLAY_NAME_KEY,
  OWN_USERNAME_KEY,
} from '../../src/core/identity/ownProfile';
import { normalizeOwnBio } from '../../src/core/social/profileEnvelope';
import { normalizeOwnStatus } from '../../src/core/social/peerStatus';
import { normalizeOwnPronouns } from '../../src/core/social/peerPronouns';
import { broadcastMyProfile, markProfileChanged } from '../../src/core/social/profileSync';
import { privacyPrefSet, privacyPrefTryGetFor } from '../../src/core/settings/privacyPrefs';
import { PRIVACY_PREF_KEYS, type PrivacyPrefKey } from '../../src/core/storage/kvKeys';
import { setMyLastSeenVisibility } from '../../src/core/social/presenceService';
import { broadcastLastSeenPref } from '../../src/core/social/presencePrefSync';

import { currentCore } from '../host';
import { captureLog, type LogEntry } from '../runtime/logBus';

/** Отказ с названной причиной. `detail` — для человека, `reason` — для кода. */
export type Refusal = { ok: false; reason: string; detail?: string; log?: string[] };

export type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Refusal;

function refuse(reason: string, detail?: string, log?: string[]): Refusal {
  return { ok: false, reason, ...(detail ? { detail } : {}), ...(log?.length ? { log } : {}) };
}

/** Ядро поднято? Все инструменты начинаются с этого вопроса. */
function core(): ReturnType<typeof currentCore> {
  return currentCore();
}

const NO_CORE = 'core_not_running';

// ── Разбор идентификатора собеседника ───────────────────────────────────────

/**
 * Привести что угодно, чем человек называет собеседника, к ключу в base64.
 *
 * Формы разбирает ядро (`parseContactId`): ссылка на профиль, `airchat://`,
 * `did:key:…` и голый base64. Своего разбора здесь нет намеренно — иначе
 * появилась бы вторая, расходящаяся с приложением, трактовка тех же строк.
 */
function toPubB64(input: string): string | null {
  const key = parseContactId(input);
  return key ? Buffer.from(key).toString('base64') : null;
}

// ── Состояние ───────────────────────────────────────────────────────────────

export type StatusResult = {
  did: string;
  profileId: number;
  transport: {
    active: boolean;
    wsOpen: boolean;
    relay: string;
    topic: string;
    reconnectAttempt: number;
  };
  startedAt: number;
  uptimeMs: number;
};

let startedAt = 0;
export function markStarted(at: number): void {
  startedAt = at;
}

export function status(): Result<StatusResult> {
  const c = core();
  if (!c) return refuse(NO_CORE, 'ядро не запущено');
  const s = getInternetTransportSingleton().getStatus();
  return {
    ok: true,
    did: c.did,
    profileId: c.pid,
    transport: {
      active: s.active,
      wsOpen: s.wsOpen,
      relay: s.relay,
      topic: s.myTopic,
      reconnectAttempt: s.reconnectAttempt,
    },
    startedAt,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
  };
}

// ── Контакты ────────────────────────────────────────────────────────────────

export type ContactView = {
  contact: string;
  did: string | null;
  displayName: string;
  username: string | null;
  verified: boolean;
  /** Строка завелась сама, при первой переписке, а не добавлением. */
  implicit: boolean;
};

function viewContact(c: Contact): ContactView {
  return {
    contact: c.peerPublicKey,
    did: didFromPubB64(c.peerPublicKey),
    displayName: c.displayName,
    username: c.peerUsername ?? null,
    verified: Boolean(c.verified),
    implicit: Boolean(c.implicit),
  };
}

export async function contactsList(): Promise<Result<{ contacts: ContactView[] }>> {
  if (!core()) return refuse(NO_CORE, 'ядро не запущено');
  const rows = await listContactsRead();
  if (rows === null) {
    return refuse(
      'read_failed',
      'список контактов прочитать не удалось; это не значит, что контактов нет'
    );
  }
  return { ok: true, contacts: rows.map(viewContact) };
}

export async function contactAdd(input: {
  id: string;
  name: string;
}): Promise<Result<{ contact: string; did: string | null; displayName: string }>> {
  const c = core();
  if (!c) return refuse(NO_CORE, 'ядро не запущено');
  const key = parseContactId(input.id);
  if (!key) {
    return refuse(
      'bad_contact_id',
      'не разобрали идентификатор: ожидается did:key:…, airchat://…, ссылка на профиль или открытый ключ в base64'
    );
  }
  const b64 = Buffer.from(key).toString('base64');
  if (b64 === Buffer.from(c.pair.publicKey).toString('base64')) {
    // Свой же ключ ядро добавит без единого возражения, и в списке появится
    // «контакт», переписка с которым — это заметки себе. Отказ здесь честнее
    // молчаливого согласия: агент почти наверняка перепутал идентификаторы.
    return refuse('self_contact', 'это собственный ключ этого аккаунта');
  }
  const name = input.name.trim();
  if (!name) return refuse('empty_name', 'имя контакта не может быть пустым');
  try {
    await addContact(c.pair, key, name);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === BAD_PUBLIC_KEY_MESSAGE) return refuse('bad_contact_id', msg);
    if (msg === CONTACT_ROW_UNREADABLE_MESSAGE) return refuse('read_failed', msg);
    if (msg === CONTACT_ROW_WRITE_FAILED_MESSAGE) return refuse('write_failed', msg);
    return refuse('add_contact_failed', msg);
  }
  return {
    ok: true,
    contact: b64,
    did: publicKeyToDidKey(key),
    // Ядро подрезает имя при записи (sanitizeDisplayName, 64 символа), поэтому
    // отдаём не то, что прислали, а то, что действительно легло.
    displayName: (await namesByContact()).get(b64) ?? name,
  };
}

/** Карта «ключ → имя» для склейки со списком переписок. */
async function namesByContact(): Promise<Map<string, string>> {
  const rows = await listContactsRead();
  const map = new Map<string, string>();
  for (const c of rows ?? []) map.set(c.peerPublicKey, c.displayName);
  return map;
}

// ── Переписки ───────────────────────────────────────────────────────────────

export type ConversationView = {
  contact: string;
  did: string | null;
  /** `null` — имени нет: контакт не заведён либо список контактов не прочитался. */
  displayName: string | null;
  unreadCount: number;
  lastMessageAt: number | null;
  /** `null` вместе с `previewUnreadable: true` — строка есть, но не расшифровалась. */
  preview: string | null;
  previewUnreadable: boolean;
  lastMessageDirection: 'in' | 'out' | null;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
};

export async function conversationsList(input?: {
  limit?: number;
}): Promise<Result<{ conversations: ConversationView[]; namesRead: 'ok' | 'failed' }>> {
  const c = core();
  if (!c) return refuse(NO_CORE, 'ядро не запущено');
  const rows = await listConversationsRead(c.pid);
  if (rows === null) {
    return refuse(
      'read_failed',
      'список переписок прочитать не удалось; это не значит, что переписок нет'
    );
  }
  // Имена читаются отдельным запросом, и он может отказать сам по себе.
  // Тогда переписки всё равно отдаются — но без вранья, будто имён не было.
  const contacts = await listContactsRead();
  const names = new Map<string, string>();
  for (const k of contacts ?? []) names.set(k.peerPublicKey, k.displayName);
  const limit = input?.limit ?? 50;
  const conversations = rows.slice(0, limit).map((r) => ({
    contact: r.contactPubB64,
    did: didFromPubB64(r.contactPubB64),
    displayName: names.get(r.contactPubB64) ?? null,
    unreadCount: r.unreadCount,
    lastMessageAt: r.lastMessageAt ?? null,
    preview: r.lastMessagePreviewUnreadable ? null : (r.lastMessagePreview ?? null),
    previewUnreadable: Boolean(r.lastMessagePreviewUnreadable),
    lastMessageDirection: r.lastMessageDirection ?? null,
    pinned: Boolean(r.pinned),
    archived: Boolean(r.archived),
    muted: Boolean(r.muted),
  }));
  return { ok: true, conversations, namesRead: contacts === null ? 'failed' : 'ok' };
}

export type MessageView = {
  id: string;
  direction: 'in' | 'out';
  /** `null` при `unreadable: true` — строка в базе есть, ключ её не открыл. */
  text: string | null;
  unreadable: boolean;
  createdAt: number;
  status: string;
  mediaCount: number;
  replyToId: string | null;
  editedAt: number | null;
};

function viewMessage(r: ChatMessageRow): MessageView {
  let mediaCount = 0;
  if (r.mediaCids) {
    try {
      const parsed = JSON.parse(r.mediaCids) as unknown;
      mediaCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      mediaCount = 0;
    }
  }
  return {
    id: r.id,
    direction: r.direction,
    text: r.unreadable ? null : r.text,
    unreadable: Boolean(r.unreadable),
    createdAt: r.createdAt,
    status: r.status,
    mediaCount,
    replyToId: r.replyToId ?? null,
    editedAt: r.editedAt ?? null,
  };
}

/**
 * Страница переписки, отсчитанная от строки, а не от числа.
 *
 * Курсор — пара «время и id» самой старой отданной строки (см.
 * `storage/chatPageCursor`): пока агент читает историю, приходят новые
 * сообщения, и счётчик пропусков молча потерял бы ровно столько же старых.
 *
 * Отказ чтения `getOlderMessages` не различает — `listChatMessages` гасит сбой
 * пустым списком. Поэтому за время вызова слушается журнал: строка
 * `chat_messages_list_failed` превращает «пусто» в честный отказ.
 */
export async function conversationMessages(input: {
  contact: string;
  limit?: number;
  before?: ChatPageCursor | null;
}): Promise<
  Result<{
    contact: string;
    messages: MessageView[];
    hasMore: boolean;
    cursor: ChatPageCursor | null;
  }>
> {
  if (!core()) return refuse(NO_CORE, 'ядро не запущено');
  const messaging = getMessagingService();
  if (!messaging) return refuse('messaging_not_ready', 'служба переписки не создана');
  const b64 = toPubB64(input.contact);
  if (!b64) return refuse('bad_contact_id', 'не разобрали идентификатор собеседника');
  if (input.before != null && !isValidCursor(input.before)) {
    return refuse('bad_cursor', 'курсор должен быть парой { createdAt, id } из прошлого ответа');
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const { value, entries } = await captureLog(() =>
    messaging.getOlderMessages(b64, limit, input.before ?? null)
  );
  const failed = entries.find((e) => e.msg === 'chat_messages_list_failed');
  if (failed) {
    return refuse(
      'read_failed',
      'страницу переписки прочитать не удалось; пустой список здесь означал бы «сообщений нет»',
      [failed.raw]
    );
  }
  return {
    ok: true,
    contact: b64,
    messages: value.messages.map(viewMessage),
    hasMore: value.hasMore,
    cursor: value.cursor,
  };
}

// ── Отправка ────────────────────────────────────────────────────────────────

/**
 * Имена отказов в журнале ядра → причины, понятные вызывающему.
 *
 * Порядок важен: при отправке служебного текста сработать может и общий
 * лимит, и лимит служебных конвертов, а сказать надо про тот, что случился.
 * Поэтому ищем по списку сверху вниз, а не берём первую попавшуюся строку.
 */
const SEND_REFUSALS: Array<{ marker: string; reason: string; detail: string }> = [
  {
    marker: 'dm_send_blocked',
    reason: 'blocked',
    detail: 'контакт заблокирован; снять блокировку может только человек в приложении',
  },
  {
    marker: 'dm_send_rate_limited',
    reason: 'rate_limited',
    detail: 'сработал часовой лимит сообщений этому контакту; ограничение пройдёт само',
  },
  {
    marker: 'dm_send_control_rate_limited',
    reason: 'rate_limited_control',
    detail: 'сработал лимит служебных конвертов этому контакту',
  },
  {
    marker: 'dm_no_session',
    reason: 'no_session',
    detail: 'нет общего ключа с этим собеседником; добавьте контакт заново по ссылке или QR',
  },
  {
    marker: 'dm_send_no_online_route',
    reason: 'no_route',
    detail: 'конверт некуда отправить: ни релей, ни другие пути не приняли его; строка сохранена со статусом failed',
  },
];

/**
 * Очередь отправок. См. пояснение в шапке файла: причина отказа читается из
 * общего журнала, и перекрытие двух отправок присвоило бы одной чужую причину.
 */
let sendQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = sendQueue.then(fn, fn);
  sendQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export type SendResult = {
  messageId: string;
  contact: string;
  /** Чем ушло, если ядро об этом сказало. `null` — путь неизвестен. */
  transport: string | null;
  elapsedMs: number;
};

export async function messageSend(input: {
  contact: string;
  text: string;
}): Promise<Result<SendResult>> {
  if (!core()) return refuse(NO_CORE, 'ядро не запущено');
  const messaging = getMessagingService();
  if (!messaging) return refuse('messaging_not_ready', 'служба переписки не создана');
  const b64 = toPubB64(input.contact);
  if (!b64) return refuse('bad_contact_id', 'не разобрали идентификатор собеседника');
  if (!input.text.trim()) return refuse('empty_text', 'пустое сообщение не отправляется');

  return serialize(async () => {
    const t0 = Date.now();
    let value: string | null;
    let entries: LogEntry[];
    try {
      const captured = await captureLog(() => messaging.sendMessage(b64, input.text));
      value = captured.value;
      entries = captured.entries;
    } catch (e) {
      // Исключение отсюда бывает одно — все вложения не загрузились
      // (`dm_media_all_failed`), а вложений мы не шлём. Значит это что-то
      // непредвиденное, и молчать о нём нельзя.
      return refuse('send_threw', e instanceof Error ? e.message : String(e));
    }
    const elapsedMs = Date.now() - t0;
    if (value === null) {
      const hit = SEND_REFUSALS.find((r) => entries.some((e) => e.msg === r.marker));
      if (hit) return refuse(hit.reason, hit.detail, [
        ...entries.filter((e) => e.msg === hit.marker).map((e) => e.raw),
      ]);
      // Один отказ ядро не называет вовсе: `if (!peerDid) return null` на
      // неразобранном ключе. Выдумывать причину нельзя — отдаём, что есть.
      return refuse(
        'unknown',
        'ядро не отправило сообщение и не назвало причину; строки журнала за время вызова приложены',
        entries.map((e) => e.raw).slice(-20)
      );
    }
    const via = entries.find((e) => e.msg === 'message_sent_via_fallback');
    return {
      ok: true as const,
      messageId: value,
      contact: b64,
      transport: (via?.meta?.transport as string | undefined) ?? null,
      elapsedMs,
    };
  });
}

// ── Карточка профиля ────────────────────────────────────────────────────────

/** Три состояния ячейки: значение, «не заполнено», «не прочиталось». */
export type FieldView =
  | { state: 'value'; value: string }
  | { state: 'unset' }
  | { state: 'unreadable' };

async function readField(pid: number, key: 'user_username' | 'user_bio' | 'user_pronouns' | 'user_custom_status' | 'user_handle'): Promise<FieldView> {
  const read = await ownFieldTryGetFor(pid, key);
  if (read === null) return { state: 'unreadable' };
  if (read.text === null || read.text === '') return { state: 'unset' };
  return { state: 'value', value: read.text };
}

export type ProfileView = {
  did: string;
  displayName: FieldView;
  bio: FieldView;
  status: FieldView;
  pronouns: FieldView;
  /** Только чтение: занятие имени идёт через общий реестр, см. profileSet. */
  username: FieldView;
};

export async function profileGet(): Promise<Result<{ profile: ProfileView }>> {
  const c = core();
  if (!c) return refuse(NO_CORE, 'ядро не запущено');
  const [displayName, bio, status_, pronouns, username] = await Promise.all([
    readField(c.pid, OWN_DISPLAY_NAME_KEY),
    readField(c.pid, 'user_bio'),
    readField(c.pid, 'user_custom_status'),
    readField(c.pid, 'user_pronouns'),
    readField(c.pid, OWN_USERNAME_KEY),
  ]);
  return {
    ok: true,
    profile: { did: c.did, displayName, bio, status: status_, pronouns, username },
  };
}

/**
 * Правка карточки — тех четырёх полей, которые здесь можно изменить честно.
 *
 * Чего в списке нет и почему:
 *
 *   `user_handle` (@имя) — занимается в ОБЩЕМ реестре имён
 *     (`saveOwnUsernameGlobally`), и простая запись в свою базу означала бы
 *     «имя занято» там, где оно не занято ни для кого, кроме нас.
 *   `user_website`, `user_twitter`, `user_github` — пишутся только вместе со
 *     своими доказательствами (`*_proof`), иначе заявка выглядит проверенной.
 *   фотография, `user_profile_cid`, бумага на галочку — это файлы и внешние
 *     реестры, а не строки.
 *
 * Значения проходят через нормализаторы приложения, а не через свои: иначе в
 * карточке появилось бы то, чего экран правки не пропустил бы.
 */
export async function profileSet(input: {
  displayName?: string;
  bio?: string;
  status?: string;
  pronouns?: string;
}): Promise<
  Result<{ changed: string[]; broadcast: 'started' | 'skipped'; profile: ProfileView }>
> {
  const c = core();
  if (!c) return refuse(NO_CORE, 'ядро не запущено');

  const writes: Array<{ field: string; key: 'user_username' | 'user_bio' | 'user_pronouns' | 'user_custom_status'; value: string }> = [];
  if (input.displayName !== undefined) {
    const name = sanitizeOwnDisplayName(input.displayName);
    if (!name) return refuse('empty_display_name', 'имя не может быть пустым');
    writes.push({ field: 'displayName', key: OWN_DISPLAY_NAME_KEY, value: name });
  }
  if (input.bio !== undefined) {
    writes.push({ field: 'bio', key: 'user_bio', value: normalizeOwnBio(input.bio) });
  }
  if (input.status !== undefined) {
    writes.push({ field: 'status', key: 'user_custom_status', value: normalizeOwnStatus(input.status) });
  }
  if (input.pronouns !== undefined) {
    writes.push({ field: 'pronouns', key: 'user_pronouns', value: normalizeOwnPronouns(input.pronouns) });
  }
  if (writes.length === 0) return refuse('nothing_to_set', 'не передано ни одного поля');

  const changed: string[] = [];
  for (const w of writes) {
    // Запись по одной, а не пачкой: `ownFieldSet` отвечает `false`, когда
    // строка не легла, и сказать «сохранено» за неё нельзя. Первый же отказ
    // прекращает правку — иначе карточка уехала бы контактам наполовину новой.
    if (!(await ownFieldSet(w.key, w.value))) {
      return refuse(
        'write_failed',
        `поле ${w.field} не записалось${changed.length ? `; до него записаны: ${changed.join(', ')}` : ''}`
      );
    }
    changed.push(w.field);
  }

  // Имя видно ещё и в реестре профилей — на телефоне это список аккаунтов.
  // Разойдясь, они дают аккаунт, который в одном месте зовут так, а в другом
  // иначе, и понять, какое имя настоящее, снаружи невозможно.
  if (input.displayName !== undefined) {
    const active = profileManager.getActiveProfile();
    const name = writes.find((w) => w.field === 'displayName')?.value;
    if (active && name) await profileManager.renameProfile(active.id, name);
  }

  // Карточка, лежащая только в своей базе, никому ничего не сообщила. Ровно
  // это делает экран правки после сохранения — отметить и разослать.
  let broadcast: 'started' | 'skipped' = 'skipped';
  try {
    await markProfileChanged();
    await broadcastMyProfile();
    broadcast = 'started';
  } catch {
    /* офлайн: разошлётся при следующем запуске, как и на телефоне */
  }

  const fresh = await profileGet();
  if (!fresh.ok) return fresh;
  return { ok: true, changed, broadcast, profile: fresh.profile };
}

// ── Приватность ─────────────────────────────────────────────────────────────

const VISIBILITY_KEYS = new Set<PrivacyPrefKey>([
  'privacy_last_seen_visibility',
  'privacy_avatar_visibility',
]);
const VISIBILITY_VALUES = ['everybody', 'contacts', 'nobody'] as const;

export type PrivacyView = Record<string, FieldView>;

export async function privacyGet(): Promise<Result<{ privacy: PrivacyView }>> {
  const c = core();
  if (!c) return refuse(NO_CORE, 'ядро не запущено');
  const out: PrivacyView = {};
  for (const key of PRIVACY_PREF_KEYS) {
    const read = await privacyPrefTryGetFor(c.pid, key);
    // Та же тройка, что и у карточки: не прочиталось ≠ не трогали. У
    // переключателя приватности разница особенно дорогая — осторожная
    // сторона у каждого своя, и выбирает её тот, кто спрашивает.
    out[key] = read === null
      ? { state: 'unreadable' }
      : read.value === null || read.value === ''
        ? { state: 'unset' }
        : { state: 'value', value: read.value };
  }
  return { ok: true, privacy: out };
}

export async function privacySet(input: {
  key: string;
  value: string;
}): Promise<Result<{ key: string; value: string; broadcast?: 'started' | 'failed' }>> {
  if (!core()) return refuse(NO_CORE, 'ядро не запущено');
  const key = PRIVACY_PREF_KEYS.find((k) => k === input.key);
  if (!key) {
    return refuse('bad_key', `неизвестная настройка; известны: ${PRIVACY_PREF_KEYS.join(', ')}`);
  }
  const wantsVisibility = VISIBILITY_KEYS.has(key);
  if (wantsVisibility) {
    if (!VISIBILITY_VALUES.includes(input.value as (typeof VISIBILITY_VALUES)[number])) {
      return refuse('bad_value', `значение должно быть одним из: ${VISIBILITY_VALUES.join(', ')}`);
    }
  } else if (input.value !== 'true' && input.value !== 'false') {
    return refuse('bad_value', 'значение должно быть "true" или "false"');
  }

  if (!(await privacyPrefSet(key, input.value))) {
    return refuse('write_failed', 'настройка не записалась; прежнее значение осталось в силе');
  }

  // «Когда я в сети» — единственная настройка, о которой узнают не из
  // карточки, а отдельной рассылкой: собеседник показывает время, пока мы его
  // об этом просим. Запись без рассылки означала бы, что запрет остался
  // только у нас, а у всех остальных решение — прежнее.
  if (key === 'privacy_last_seen_visibility') {
    setMyLastSeenVisibility(input.value);
    try {
      await broadcastLastSeenPref();
      return { ok: true, key, value: input.value, broadcast: 'started' };
    } catch {
      return { ok: true, key, value: input.value, broadcast: 'failed' };
    }
  }
  return { ok: true, key, value: input.value };
}
