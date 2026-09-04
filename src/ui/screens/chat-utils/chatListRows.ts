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
  avatarCid?: string;
  verified?: 'official';
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
    });
  }
  return rows;
}
