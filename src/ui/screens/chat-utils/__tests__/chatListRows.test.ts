/**
 * Архивированный чат уходит из основного списка целиком (v4.32.584).
 *
 * Экран читал только тот список переписок, который показывал. Контакт, чей
 * диалог уехал в архив, в этот список не попадал — и тут же подставлялся
 * второй раз, как «контакт без переписки». Человек архивировал чат, а строка
 * с тем же именем оставалась на месте, только пустая.
 */
import { buildChatListRows, type RowContact } from '../chatListRows';
import type { ConversationRow } from '../../../../core/storage/local';

const conv = (pub: string, over: Partial<ConversationRow> = {}): ConversationRow => ({
  contactPubB64: pub,
  ownerProfileId: 1,
  unreadCount: 0,
  draftText: null,
  pinned: false,
  archived: false,
  muted: false,
  mutedUntil: null,
  lastMessageAt: 1000,
  lastMessagePreview: 'привет',
  lastMessageDirection: 'in',
  pinnedMessageId: null,
  disappearAfterMs: null,
  colorTag: null,
  ...over,
});

const contact = (pub: string, name: string): RowContact => ({ peerPublicKey: pub, displayName: name });

const build = (over: Partial<Parameters<typeof buildChatListRows>[0]>) =>
  buildChatListRows({
    openConversations: [],
    archivedConversations: [],
    contacts: [],
    showArchived: false,
    ownerProfileId: 1,
    myPubB64: null,
    shortIdentity: (p) => p.slice(0, 6),
    ...over,
  });

describe('buildChatListRows', () => {
  it('архивированный чат не оставляет копию в основном списке', () => {
    const rows = build({
      archivedConversations: [conv('bob', { archived: true })],
      contacts: [contact('bob', 'Боб')],
    });
    expect(rows).toEqual([]);
  });

  it('контакт без единой переписки строку получает', () => {
    const rows = build({ contacts: [contact('bob', 'Боб')] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ contactPubB64: 'bob', displayName: 'Боб', lastMessageAt: 0 });
  });

  it('в архиве показаны только архивные переписки — контакты не подмешиваются', () => {
    const rows = build({
      showArchived: true,
      openConversations: [conv('alice')],
      archivedConversations: [conv('bob', { archived: true })],
      contacts: [contact('alice', 'Алиса'), contact('bob', 'Боб'), contact('carol', 'Кэрол')],
    });
    expect(rows.map((r) => r.contactPubB64)).toEqual(['bob']);
  });

  it('обычный список — открытые переписки и контакты без истории, без дублей', () => {
    const rows = build({
      openConversations: [conv('alice')],
      archivedConversations: [conv('bob', { archived: true })],
      contacts: [contact('alice', 'Алиса'), contact('bob', 'Боб'), contact('carol', 'Кэрол')],
    });
    expect(rows.map((r) => r.contactPubB64)).toEqual(['alice', 'carol']);
    expect(new Set(rows.map((r) => r.contactPubB64)).size).toBe(rows.length);
  });

  it('свой ключ выкинут из обоих списков — он живёт в шапке', () => {
    const rows = build({
      myPubB64: 'me',
      openConversations: [conv('me'), conv('alice')],
      contacts: [contact('me', 'Я'), contact('alice', 'Алиса')],
    });
    expect(rows.map((r) => r.contactPubB64)).toEqual(['alice']);
  });

  it('имя и фото берутся у контакта, иначе — короткая подпись ключа', () => {
    const rows = build({
      openConversations: [conv('alice'), conv('unknownpeer')],
      contacts: [{ peerPublicKey: 'alice', displayName: 'Алиса', avatarCid: 'cid1', verified: 'official' }],
    });
    expect(rows[0]).toMatchObject({ displayName: 'Алиса', avatarCid: 'cid1', verified: 'official' });
    expect(rows[1].displayName).toBe('unknow');
  });
});
