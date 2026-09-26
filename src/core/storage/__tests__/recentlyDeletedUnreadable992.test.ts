/**
 * Дефект. Корзина «Недавно удалённые» читалась через `kvGetSecretScoped`, а он
 * сводит «записи нет» и «запись не открылась» к одному `null`. Окно в обоих
 * случаях писало «Нет удалённых сообщений» — утверждение, которого никто не
 * проверял.
 *
 * Цена. Корзина — последняя копия текста (v4.32.892). Человек, прочитавший
 * «Нет удалённых сообщений», второй раз туда не пойдёт; запись живёт семь
 * суток в группе и тридцать в переписке, после чего её отсеет срок хранения.
 * Сама запись при этом цела: писать поверх нечитаемого запрещено с v4.32.552 —
 * то есть терялась ровно и только возможность её увидеть.
 *
 * Правка. Чтение стало трёхсостоянным и переехало в один модуль на оба экрана
 * вместе с разбором и сроком хранения; «не открылось» говорится словами.
 *
 * Границы. Пустая корзина по-прежнему пуста и по-прежнему так и называется.
 * Обещания «вернётся» в тексте нет: `unreadable` — это и не ответившая база, и
 * недостающий ключ, и чужой шифртекст, а различить их здесь нечем.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { cellTextOrNull } from '../atRestCell';

let mockCell: { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' } = { state: 'absent' };

jest.mock('../local', () => ({
  kvGetSecretCellScoped: jest.fn(async () => mockCell),
}));

const SRC = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Пины ищут вызов, а не слово: собственный пояснительный комментарий их бы устроил. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const GROUPS = read('ui/screens/GroupsScreen.tsx');
const CHAT = read('ui/screens/ChatScreen.tsx');
const LOCAL = read('core/storage/local.ts');

type Entry = { id: string; deletedAt: number };

describe('нечитаемая корзина не выдаётся за пустую', () => {
  it('«не открылось» отличается от «пусто» в самом ответе чтения', async () => {
    const { readRecentlyDeletedFor } = await import('../recentlyDeletedRead');
    mockCell = { state: 'unreadable' };
    expect(await readRecentlyDeletedFor<Entry>(1, 'k', 1000)).toEqual({ ok: false });
    mockCell = { state: 'absent' };
    expect(await readRecentlyDeletedFor<Entry>(1, 'k', 1000)).toEqual({ ok: true, list: [] });
  });

  it('оба экрана на такой ответ показывают фразу и не открывают окно', async () => {
    const { RECENTLY_DELETED_UNREADABLE_TEXT } = await import('../recentlyDeletedRead');
    expect(RECENTLY_DELETED_UNREADABLE_TEXT.length).toBeGreaterThan(0);
    for (const src of [GROUPS, CHAT]) {
      expect(src).toContain('if (!read.ok) { showError(RECENTLY_DELETED_UNREADABLE_TEXT); return; }');
    }
  });

  it('фраза отрицает ложное прочтение и ничего не обещает', async () => {
    const { RECENTLY_DELETED_UNREADABLE_TEXT: t } = await import('../recentlyDeletedRead');
    expect(t).toContain('не значит, что она пуста');
    expect(t).toContain('не стёрто');
    expect(t).not.toContain('восстанов');
    expect(t).not.toContain('позже');
  });

  it('прежнего глухого чтения корзины в экранах не осталось', () => {
    expect(codeOnly(GROUPS)).not.toContain('kvGetSecretScoped(pid, recentlyDeletedGroupKey');
    expect(codeOnly(CHAT)).not.toContain('kvGetSecretScoped(activeProfileId, recentlyDeletedKey');
  });
});

describe('разбор корзины — одно правило на оба экрана', () => {
  it('объект вместо массива больше не роняет открытие', async () => {
    const { parseRecentlyDeleted } = await import('../recentlyDeletedRead');
    expect(parseRecentlyDeleted<Entry>('{"a":1}', 1000)).toEqual([]);
    expect(parseRecentlyDeleted<Entry>('не json', 1000)).toEqual([]);
    expect(parseRecentlyDeleted<Entry>(null, 1000)).toEqual([]);
  });

  it('пустое место в списке не роняет фильтр', async () => {
    const { parseRecentlyDeleted } = await import('../recentlyDeletedRead');
    const now = 10_000;
    expect(parseRecentlyDeleted<Entry>('[null,{"id":"a","deletedAt":9999}]', 1000, now)).toEqual([
      { id: 'a', deletedAt: 9999 },
    ]);
  });

  it('рубеж срока хранения тот же, что был у обоих экранов', async () => {
    const { parseRecentlyDeleted } = await import('../recentlyDeletedRead');
    const now = 10_000;
    const raw = '[{"id":"свежая","deletedAt":9001},{"id":"ровно","deletedAt":9000},{"id":"старая","deletedAt":8999}]';
    expect(parseRecentlyDeleted<Entry>(raw, 1000, now).map((x) => x.id)).toEqual(['свежая']);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('чтение строкой по-прежнему сводит «нет» и «не открылось» к одному null', () => {
    expect(cellTextOrNull({ state: 'absent' })).toBeNull();
    expect(cellTextOrNull({ state: 'unreadable' })).toBeNull();
    expect(cellTextOrNull({ state: 'plain', text: '' })).toBe('');
  });

  it('окна по-прежнему утверждают пустоту, когда список пуст', () => {
    expect(read('ui/components/modals/groups/GroupRecentlyDeletedModal.tsx')).toContain(
      'Нет недавно удалённых сообщений',
    );
    expect(read('ui/components/modals/chat/ChatRecentlyDeletedModal.tsx')).toContain('Нет удалённых сообщений');
  });

  it('писать поверх нечитаемой корзины по-прежнему нельзя — значит она цела', () => {
    expect(LOCAL).toContain("if (outcome === 'refuse-unreadable')");
    expect(GROUPS).toContain('kvUpdateSecretScoped(pid, recentlyDeletedGroupKey(group.id)');
    expect(CHAT).toContain('kvUpdateSecretScoped(activeProfileId, recentlyDeletedKey(peerB64)');
  });

  it('корзина по-прежнему последняя копия: в группе восстановление её вычёркивает', () => {
    expect(GROUPS).toContain('v4.32.892');
    expect(GROUPS).toContain('setGrpRecentlyDeletedList((prev) => prev.filter((x) => x.id !== entry.id));');
  });
});
