/**
 * Сборка строк списка чатов из переписок и контактов (v4.32.584).
 *
 * Правило одно и живёт здесь, а не внутри экрана, потому что ошибиться в нём
 * легко и незаметно. Раньше экран читал только тот список, который показывал:
 * в обычном режиме — незаархивированные переписки. Контакт, чей диалог лежал
 * в архиве, в этот список не попадал, и следом его подставляли ещё раз — как
 * «контакт без переписки», пустой строкой с нулевым временем. Со стороны это
 * выглядело так, будто чат после архивации остался на месте: имя то же, а
 * последнего сообщения нет.
 */
import type { ConversationRow } from '../../../core/storage/local';

/** Всё, что нужно от контакта, чтобы нарисовать строку. */
export type RowContact = {
  peerPublicKey: string;
  displayName: string;
  avatarCid?: string;
  verified?: 'official';
};

export type ChatListRow = ConversationRow & {
  displayName: string;
  /** v4.32.247: фото контакта из его же конверта профиля (см. profileSync). */
  avatarCid?: string;
  /**
   * v4.32.547: официальная галочка контакта. Список чатов — то самое место,
   * где её отсутствие стоит дорого: похожее имя и похожее фото здесь стоят
   * рядом с настоящими, и отличить их до открытия переписки больше нечем.
   */
  verified?: 'official';
  /**
   * v4.32.1002: строка заведена контакту, у которого переписки нет ни одной.
   * Переписки за ней не стоит — ни открытой, ни архивной, ни пустой: в базе
   * такой строки просто нет. Отличать её обязательно, потому что по всем
   * остальным признакам она выглядит как прочитанная незакреплённая
   * переписка (`unreadCount: 0`, `pinned: false`, `archived: false`), и
   * пачечные действия принимали её за настоящую.
   */
  contactOnly?: boolean;
};

export type BuildChatListRowsInput = {
  /** Переписки вне архива — весь список профиля, а не только показанный. */
  openConversations: ConversationRow[];
  /** Переписки в архиве — тоже весь список. */
  archivedConversations: ConversationRow[];
  contacts: RowContact[];
  /** Какой из двух списков сейчас на экране. */
  showArchived: boolean;
  ownerProfileId: number;
  /** Собственный ключ: «Сохранённые сообщения» живут в шапке, не в списке. */
  myPubB64: string | null;
  shortIdentity: (pub: string) => string;
};

export function buildChatListRows(input: BuildChatListRowsInput): ChatListRow[] {
  const { openConversations, archivedConversations, contacts, showArchived } = input;
  const mine = input.myPubB64;
  const notMe = <T,>(list: T[], key: (v: T) => string): T[] =>
    mine ? list.filter((v) => key(v) !== mine) : list;

  const open = notMe(openConversations, (c) => c.contactPubB64);
  const archived = notMe(archivedConversations, (c) => c.contactPubB64);
  const ctacts = notMe(contacts, (c) => c.peerPublicKey);

  const byPub = new Map<string, RowContact>();
  for (const c of ctacts) byPub.set(c.peerPublicKey, c);

  const shown = showArchived ? archived : open;
  const rows: ChatListRow[] = shown.map((c) => ({
    ...c,
    displayName: byPub.get(c.contactPubB64)?.displayName || input.shortIdentity(c.contactPubB64),
    avatarCid: byPub.get(c.contactPubB64)?.avatarCid,
    verified: byPub.get(c.contactPubB64)?.verified,
  }));

  // Пустую строку заводим только контакту, у которого переписки нет НИ ОДНОЙ —
  // ни здесь, ни в архиве. И только вне архива: тому, кому ни разу не писали,
  // в архиве делать нечего.
  if (showArchived) return rows;
  const known = new Set<string>();
  for (const c of open) known.add(c.contactPubB64);
  for (const c of archived) known.add(c.contactPubB64);
  for (const ct of ctacts) {
    if (known.has(ct.peerPublicKey)) continue;
    rows.push({
      contactPubB64: ct.peerPublicKey,
      ownerProfileId: input.ownerProfileId,
      unreadCount: 0,
      draftText: null,
      pinned: false,
      archived: false,
      muted: false,
      mutedUntil: null,
      lastMessageAt: 0,
      lastMessagePreview: null,
      lastMessageDirection: null,
      pinnedMessageId: null,
      disappearAfterMs: null,
      colorTag: null,
      displayName: ct.displayName,
      avatarCid: ct.avatarCid,
      verified: ct.verified,
      contactOnly: true,
    });
  }
  return rows;
}

/**
 * Кого уносит «Архивировать прочитанные» (v4.32.1002).
 *
 * Дефект. Отбор стоял прямо на экране и читался как «переписки без
 * непрочитанных»: `unreadCount === 0 && !pinned && !archived`. Но идёт он по
 * строкам, которые собрала функция выше, а среди них есть строка контакта,
 * которому ни разу не писали, — и все три признака у неё именно такие.
 * Контакт уезжал в архив вместе с переписками.
 *
 * Цена. `setConversationArchived` не переставляет флаг, а заводит строку
 * переписки заново — с `archived = 1`. До нажатия переписки не было вовсе, и
 * контакт стоял в основном списке как «контакт без истории»; после — у него
 * появилась архивная переписка, и правило «контакту заводим строку, только
 * если переписки нет ни одной» больше его не пускает. С главного экрана
 * человек пропадает совсем, а найти его можно лишь в архиве, где он выглядит
 * пустой строкой без единого сообщения. Обратной кнопки для этого нет:
 * «Разархивировать» есть только у того, кого видно.
 *
 * Правка. Правило живёт здесь, рядом с тем, кто эти строки создаёт, и
 * пропускает только настоящие переписки.
 */
export function rowsToArchiveOnBulk(rows: ChatListRow[]): ChatListRow[] {
  return rows.filter((r) => r.contactOnly !== true && r.unreadCount === 0 && !r.pinned && !r.archived);
}
