/**
 * «Архивировать прочитанные» уносило контактов, с которыми переписки нет
 * (v4.32.1002).
 *
 * Дефект. Отбор стоял на экране и читался как «переписки без непрочитанных»:
 * `unreadCount === 0 && !pinned && !archived`. Идёт он, однако, по строкам,
 * которые собрал `buildChatListRows`, а тот подставляет контакту без истории
 * пустую строку — и все три признака у неё именно такие.
 *
 * Цена. `setConversationArchived` не переставляет флаг, а заводит строку
 * переписки заново, с `archived = 1`. До нажатия переписки не было вовсе, и
 * контакт стоял в основном списке; после — у него появилась архивная
 * переписка, и правило «контакту заводим строку, только если переписки нет ни
 * одной» больше его туда не пускает. С главного экрана человек исчезает, а
 * лежит в архиве пустой строкой без единого сообщения; «Разархивировать» есть
 * только у того, кого видно, так что обратной кнопки нет.
 *
 * Правка. Строка контакта помечена `contactOnly`, а отбор переехал к тому, кто
 * эти строки создаёт, — `rowsToArchiveOnBulk`.
 *
 * Границы. Настоящую прочитанную переписку правило по-прежнему уносит;
 * закреплённую и уже архивную — по-прежнему нет.
 */
import fs from 'fs';
import path from 'path';

import { buildChatListRows, rowsToArchiveOnBulk, type RowContact } from '../chatListRows';
import type { ConversationRow } from '../../../../core/storage/local';

const SRC = path.join(__dirname, '..', '..', '..', '..', '..');
const SCREEN = path.join(SRC, 'src', 'ui', 'screens', 'ChatListScreen.tsx');
const ROWS = path.join(SRC, 'src', 'ui', 'screens', 'chat-utils', 'chatListRows.ts');

const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

/** Своё же пояснение в комментарии не должно засчитываться за код. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

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

describe('ПРОВЕРКА НЕ ПУСТАЯ: строки и экран на месте', () => {
  it('сборка строк подставляет контакту без переписки пустую строку', () => {
    const rows = build({ contacts: [contact('ct', 'Аня')] });
    expect(rows).toHaveLength(1);
    expect(rows[0].contactPubB64).toBe('ct');
    expect(rows[0].lastMessageAt).toBe(0);
  });

  it('экран читается и собирает список через buildChatListRows', () => {
    const s = read(SCREEN);
    expect(s.length).toBeGreaterThan(1000);
    expect(s).toContain('buildChatListRows(');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: строка контакта неотличима по трём признакам', () => {
  it('у пустой строки контакта нет непрочитанных, она не закреплена и не архивна', () => {
    const rows = build({ contacts: [contact('ct', 'Аня')] });
    expect(rows[0].unreadCount).toBe(0);
    expect(rows[0].pinned).toBe(false);
    expect(rows[0].archived).toBe(false);
  });

  it('пачка по-прежнему идёт через runGuardedOp и считает отказавшие', () => {
    const s = read(SCREEN);
    expect(s).toContain("'chat_list_archive_read_failed'");
    expect(s).toContain('Не удалось архивировать: ${failed} из ${readConvs.length}');
  });
});

describe('отбор пачки', () => {
  it('контакта, которому ни разу не писали, в архив не уносит', () => {
    const rows = build({ contacts: [contact('ct', 'Аня')] });
    expect(rowsToArchiveOnBulk(rows)).toEqual([]);
  });

  it('прочитанную переписку уносит, а контакта из того же списка — нет', () => {
    const rows = build({
      openConversations: [conv('real')],
      contacts: [contact('real', 'Боря'), contact('ct', 'Аня')],
    });
    expect(rows).toHaveLength(2);
    expect(rowsToArchiveOnBulk(rows).map((r) => r.contactPubB64)).toEqual(['real']);
  });

  it('строка контакта помечена contactOnly, строка переписки — нет', () => {
    const rows = build({ openConversations: [conv('real')], contacts: [contact('ct', 'Аня')] });
    const byPub = new Map(rows.map((r) => [r.contactPubB64, r]));
    expect(byPub.get('ct')?.contactOnly).toBe(true);
    expect(byPub.get('real')?.contactOnly).toBeUndefined();
  });
});

describe('ГРАНИЦА: остальные три условия не тронуты', () => {
  it('переписку с непрочитанными не уносит', () => {
    const rows = build({ openConversations: [conv('a', { unreadCount: 3 })] });
    expect(rowsToArchiveOnBulk(rows)).toEqual([]);
  });

  it('закреплённую прочитанную переписку не уносит', () => {
    const rows = build({ openConversations: [conv('a', { pinned: true })] });
    expect(rowsToArchiveOnBulk(rows)).toEqual([]);
  });

  it('уже архивную переписку второй раз не уносит', () => {
    const rows = build({ openConversations: [conv('a', { archived: true })] });
    expect(rowsToArchiveOnBulk(rows)).toEqual([]);
  });
});

describe('экран не отбирает строки сам', () => {
  it('старого встроенного отбора на экране нет', () => {
    const s = codeOnly(read(SCREEN));
    expect(s).not.toContain('conversations.filter((c) => c.unreadCount === 0 && !c.pinned && !c.archived)');
  });

  it('экран зовёт общее правило', () => {
    const s = codeOnly(read(SCREEN));
    expect(s).toContain('const readConvs = rowsToArchiveOnBulk(conversations);');
    expect(s).toContain("rowsToArchiveOnBulk");
  });

  it('правило живёт рядом со сборкой строк', () => {
    const r = read(ROWS);
    expect(r).toContain('export function rowsToArchiveOnBulk(');
  });
});

describe('подтверждение не обещает лишнего', () => {
  it('не говорит «все переписки»', () => {
    const s = codeOnly(read(SCREEN));
    expect(s).not.toContain('Все переписки без непрочитанных сообщений будут архивированы.');
  });

  it('называет, кто остаётся на месте', () => {
    const s = codeOnly(read(SCREEN));
    const at = s.indexOf("'Архивировать прочитанные?'");
    expect(at).toBeGreaterThan(0);
    const tail = s.slice(at, at + 400);
    expect(tail).toContain('Закреплённые останутся на месте');
    expect(tail).toContain('контакты без переписки');
  });
});
