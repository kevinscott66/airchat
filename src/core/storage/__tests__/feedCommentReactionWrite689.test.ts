/**
 * Реакция на комментарий: рассылаем только то, что легло к нам (v4.32.689).
 *
 * `updateCommentReactions` закрыта от разрушающей записи с v4.32.544 и с тех
 * пор отказывает молча: нечитаемый столбец выходит ранним `return`, а
 * несуществующий комментарий — UPDATE'ом, который не задел ни одной строки.
 * Возвращала она `void`, и `toggleCommentReaction` в обоих случаях шёл
 * дальше: поднимал ленту и рассылал `feed_comment_reaction` контактам. У них
 * реакция появлялась, у нас — нет.
 *
 * Хуже второй случай. С v4.32.687 нечитаемый столбец приходит в ленту как
 * `reactions: null`, значит карта собиралась заново из пустой — и рассылка
 * велела контактам снять реакции, которые у них ЕСТЬ, а у нас всего лишь не
 * открываются ключом этого устройства.
 *
 * У поста это правило действует с v4.32.608, и `addAndBroadcastReaction` его
 * прямо называет: «запись может не состояться … тогда рассылать нечего: у
 * получателей появилось бы то, чего нет у нас». Комментарий из-под правила
 * выпал.
 *
 * Здесь проверяются договор хранилища («записал / не записал») поведением и
 * то, что лента и экран этим ответом действительно пользуются.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Row = Record<string, unknown>;

const mockComments: Row[] = [];

/** Столбец, который не открывается ключом этого устройства. */
const LOCKED = 'enc2:НЕ-ОТКРОЕТСЯ';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => ({
    execAsync: jest.fn(async () => undefined),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (!sql.includes('feed_comments')) return null;
      return mockComments.find((r) => r.id === params[0]) ?? null;
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('UPDATE feed_comments SET reactions')) {
        const [reactions, id] = params as [string, string];
        const row = mockComments.find((r) => r.id === id);
        // Настоящий SQLite на несовпавшем WHERE не трогает ни одной строки.
        if (!row) return { changes: 0, lastInsertRowId: 0 };
        row.reactions = reactions;
        return { changes: 1, lastInsertRowId: 0 };
      }
      return { changes: 0, lastInsertRowId: 0 };
    }),
  })),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-file-system/legacy', () => ({ documentDirectory: '/doc/' }));

jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('../localEncryption', () => ({
  AT_REST_PREFIX: 'enc2:',
  AT_REST_COLUMNS: [],
  getOrCreateDataEncryptionKey: jest.fn(async () => new Uint8Array(32)),
  encryptAtRestString: jest.fn((v: string) => v),
  encryptAtRestNullable: jest.fn((v: string | null) => v),
  decryptAtRestString: jest.fn((v: string) => v),
  decryptAtRestNullable: jest.fn((v: string | null) => v),
  isAtRestCiphertext: jest.fn(() => false),
  resetDataEncryptionKeyCache: jest.fn(),
  // Единственная развилка, которая здесь важна: открылся столбец или нет.
  readAtRestCell: jest.fn((stored: string | null) => {
    if (stored === null || stored === undefined) return { state: 'absent' };
    if (stored === 'enc2:НЕ-ОТКРОЕТСЯ') return { state: 'unreadable' };
    return { state: 'plain', text: stored };
  }),
}));

import { FeedStorage } from '../feedStorage';
import { reactionUnreadableText, reactionWriteFailureText } from '../../social/reactionWrite';

let s: FeedStorage;

beforeEach(() => {
  mockComments.length = 0;
  s = new FeedStorage(1);
});

const MAP = { '👍': ['did:key:zMe'] };

describe('updateCommentReactions отвечает, легла ли запись', () => {
  it('обычный столбец — true, карта на месте', async () => {
    mockComments.push({ id: 'c-1', reactions: '{}' });
    expect(await s.updateCommentReactions('c-1', MAP)).toBe(true);
    expect(mockComments[0].reactions).toBe(JSON.stringify(MAP));
  });

  it('пустого столбца ещё нет — писать можно, это законное начало', async () => {
    mockComments.push({ id: 'c-1', reactions: null });
    expect(await s.updateCommentReactions('c-1', MAP)).toBe(true);
    expect(mockComments[0].reactions).toBe(JSON.stringify(MAP));
  });

  it('столбец не открылся — false, прежний шифртекст не тронут', async () => {
    mockComments.push({ id: 'c-1', reactions: LOCKED });
    expect(await s.updateCommentReactions('c-1', MAP)).toBe(false);
    expect(mockComments[0].reactions).toBe(LOCKED);
  });

  it('комментария уже нет — false, а не молчаливый UPDATE в пустоту', async () => {
    expect(await s.updateCommentReactions('c-нет', MAP)).toBe(false);
    expect(mockComments).toHaveLength(0);
  });
});

describe('причину отказа называют одними словами для всех трёх предметов', () => {
  it('текст свой у каждого', () => {
    const texts = (['message', 'post', 'comment'] as const).map(reactionUnreadableText);
    expect(new Set(texts).size).toBe(3);
    for (const t of texts) expect(t).toContain('ключ этого устройства');
  });

  it('текст для переписки не изменился ни на байт', () => {
    expect(reactionWriteFailureText('unreadable')).toBe(reactionUnreadableText('message'));
    expect(reactionUnreadableText('message')).toBe(
      'Реакции этого сообщения не удалось прочитать: их не открывает ключ этого устройства',
    );
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: текст помещается на всплывающую подсказку', () => {
    for (const subject of ['message', 'post', 'comment'] as const) {
      const t = reactionUnreadableText(subject);
      expect(t.length).toBeGreaterThan(40);
      expect(t.length).toBeLessThanOrEqual(160);
      expect(t).not.toContain('\n');
    }
  });
});

describe('лента рассылает реакцию комментария только после записи', () => {
  const SRC = readFileSync(join(__dirname, '..', '..', 'social', 'feedService.ts'), 'utf8');

  const body = (from: string, to: string): string => {
    const a = SRC.indexOf(from);
    expect(a).toBeGreaterThan(0);
    const b = SRC.indexOf(to, a);
    expect(b).toBeGreaterThan(a);
    return SRC.slice(a, b);
  };

  it('нечитаемый столбец отказывает ДО того, как карта собрана заново', () => {
    const b = body('export function toggleCommentReaction(', 'const tracked = operation.finally(');
    expect(b.length).toBeGreaterThan(1000);
    expect(b).toContain("if (comment.reactionsUnreadable) throw new Error(reactionUnreadableText('comment'));");
    expect(b.indexOf('comment.reactionsUnreadable')).toBeLessThan(
      b.indexOf('const reactions: Record<string, string[]> = comment.reactions'),
    );
  });

  it('выход по несостоявшейся записи стоит до подъёма ленты и до рассылки', () => {
    const b = body('export function toggleCommentReaction(', 'const tracked = operation.finally(');
    expect(b).toContain('if (!(await s.updateCommentReactions(commentId, reactions))) {');
    const guard = b.indexOf('if (!(await s.updateCommentReactions(commentId, reactions))) {');
    expect(guard).toBeLessThan(b.indexOf('emitFeedUpdate();'));
    expect(guard).toBeLessThan(b.indexOf("type: 'feed_comment_reaction',"));
  });

  it('входящая реакция не отчитывается о приёме, если её не записали', () => {
    const b = body("case 'feed_comment_reaction': {", "case 'feed_comment': {");
    expect(b.length).toBeGreaterThan(500);
    expect(b).toContain("log.warn('feed_comment_reaction_not_stored'");
    expect(b.indexOf("log.warn('feed_comment_reaction_not_stored'")).toBeLessThan(
      b.indexOf("log.info('feed_comment_reaction_received'"),
    );
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: беззвучного вызова не осталось ни одного', () => {
    expect(SRC).not.toContain('\n    await s.updateCommentReactions(');
    expect(SRC).not.toContain('\n      await s.updateCommentReactions(');
    expect(SRC.split('updateCommentReactions(').length - 1).toBe(2);
  });

  it('у поста нечитаемый столбец тоже назван, а не сведён к общему сбою', () => {
    const b = body('export async function toggleAndBroadcastReaction(', 'emitFeedUpdate();');
    expect(b).toContain("if (existing?.reactionsUnreadable) throw new Error(reactionUnreadableText('post'));");
    expect(b.indexOf('existing?.reactionsUnreadable')).toBeLessThan(
      b.indexOf("throw new Error('Не удалось сохранить реакцию');"),
    );
  });
});

describe('экран ленты показывает названный отказ, а не только потолок', () => {
  const SCREEN = readFileSync(
    join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'),
    'utf8',
  );

  it('файл прочитан целиком', () => {
    expect(SCREEN.length).toBeGreaterThan(100_000);
  });

  it('показывают любой наш русский текст, а сбои библиотек по-прежнему молчат', () => {
    expect(SCREEN).toContain('const raw = rawErrorText(e);');
    expect(SCREEN).toContain('if (isUserFacingMessage(raw)) showError(raw);');
    expect(SCREEN).not.toContain('isReactionLimitError');
  });
});
