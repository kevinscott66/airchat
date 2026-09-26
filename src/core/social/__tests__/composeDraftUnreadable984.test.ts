/**
 * Черновик поста переживает занятую базу (v4.32.984).
 *
 * Снимок черновика существует ради одного случая: следом за ним открывается
 * системный picker, наша активити уходит в фон, и система вправе её убить
 * (v4.32.73). Вернуться после этого можно только к снимку — и поднимают его
 * при следующем запуске приложения.
 *
 * Отсюда и дефект. Чтение шло через `kvGetSecret`, а тот отвечает одним и тем
 * же `null` и на «снимка нет», и на «база не открылась». Первая секунда после
 * запуска — самая занятая у SQLite (ради неё в проекте заведён
 * `storage/readRetry`), а восстановление черновика зовётся именно в неё: это и
 * есть перезапуск после убитой активити. Один отказ базы — и экран открывал
 * composer пустым: набранный текст, фото, гео-метка и опрос пропадали с глаз.
 * Второго захода не было — эффект в ленте одноразовый, на `[did]`. Снимок при
 * этом лежал на диске целым и через полчаса протухал сам.
 *
 * Правка. Чтение различает три состояния и пережидает занятую базу теми же
 * паузами, что и остальные (`READ_RETRY_ATTEMPTS`). Если не открылось и после
 * повторов — снимок не стирают, о поводе пишут в журнал, а на экран не
 * поднимают ничего: лучше пустой composer, чем чужой или устаревший текст.
 *
 * Границы. Повторов конечное число: дольше человек уже чувствует задержку.
 * Запись времён до v4.32.292 (открытым текстом, с did в ключе) по-прежнему
 * снимается с диска всегда, но подставляется вместо своего снимка только
 * тогда, когда свой прочитан и пуст.
 */
import fs from 'fs';
import path from 'path';

const DID = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PID = 3;
const SCOPED = `p${PID}:feed_compose_pending`;
const LEGACY = `feed_compose_pending:${DID}`;

type Cell =
  | { state: 'absent' }
  | { state: 'plain'; text: string }
  | { state: 'unreadable' };

/** Открытые строки хранилища: имитируют `kv`-таблицу. */
const mockKv = new Map<string, string>();
/** Сколько ближайших чтений зашифрованной ячейки база отклонит. */
let mockReadRefusals = 0;
/** Сколько раз к зашифрованной ячейке вообще обратились. */
let mockCellReads = 0;
const mockLogWarn = jest.fn();

jest.mock('../../storage/local', () => ({
  kvGetSecretCell: jest.fn(async (key: string): Promise<Cell> => {
    mockCellReads += 1;
    if (mockReadRefusals > 0) { mockReadRefusals -= 1; return { state: 'unreadable' }; }
    const v = mockKv.get(key);
    return v == null ? { state: 'absent' } : { state: 'plain', text: v };
  }),
  // Настоящий `kvGetSecret` написан поверх ячейки и теряет разницу между «нет»
  // и «не открылось». Мок обязан терять её так же — иначе прогон на
  // дореформенном дереве шёл бы по несуществующему коду.
  kvGetSecret: jest.fn(async (key: string): Promise<string | null> => {
    mockCellReads += 1;
    if (mockReadRefusals > 0) { mockReadRefusals -= 1; return null; }
    return mockKv.get(key) ?? null;
  }),
  kvSetSecret: jest.fn(async (key: string, value: string): Promise<boolean> => {
    mockKv.set(key, value);
    return true;
  }),
  kvGet: jest.fn(async (key: string): Promise<string | null> => mockKv.get(key) ?? null),
  kvDelete: jest.fn(async (key: string): Promise<void> => { mockKv.delete(key); }),
}));

jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => ({ id: 3, did: 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    getAllProfiles: () => [{ id: 3, did: 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
  },
}));

jest.mock('../../logger', () => ({
  log: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
  },
}));

import { loadComposeDraft, saveComposeDraft, type ComposeDraft } from '../composeDraft';

const SNAP: ComposeDraft = {
  draft: 'половина поста, которую человек уже набрал',
  uris: ['file:///photo/1.jpg'],
  pickedDocs: [],
  postLocationTag: null,
  isPollMode: false,
  pollQuestion: '',
  pollOptions: ['', ''],
  editingPostId: null,
};

const warns = (): string[] => mockLogWarn.mock.calls.map((c) => String(c[0]));

/** Снимок, который человек оставил перед тем, как открыть picker. */
async function draftOnDisk(): Promise<void> {
  expect(await saveComposeDraft(DID, SNAP)).toBe(true);
  expect(mockKv.has(SCOPED)).toBe(true);
}

/** Черновик времён до v4.32.292: открытым текстом и с did в ключе. */
function legacyOnDisk(text: string): void {
  mockKv.set(LEGACY, JSON.stringify({ draft: text, ts: Date.now() }));
}

beforeEach(() => {
  mockKv.clear();
  mockReadRefusals = 0;
  mockCellReads = 0;
  mockLogWarn.mockClear();
});

describe('занятая база больше не выглядит как пустой черновик', () => {
  it('отпустила со второго захода — набранный пост вернулся', async () => {
    await draftOnDisk();
    mockCellReads = 0;
    mockReadRefusals = 1;

    const snap = await loadComposeDraft(DID);

    expect(snap?.draft).toBe(SNAP.draft);
    expect(snap?.uris).toEqual(SNAP.uris);
  });

  it('и с последнего — тоже', async () => {
    await draftOnDisk();
    mockReadRefusals = 2;

    expect((await loadComposeDraft(DID))?.draft).toBe(SNAP.draft);
  });

  it('повторов ровно столько, сколько обещано: ждать дольше человек не станет', async () => {
    await draftOnDisk();
    mockCellReads = 0;
    mockReadRefusals = 99;

    expect(await loadComposeDraft(DID)).toBeNull();
    // Первый заход плюс READ_RETRY_ATTEMPTS повторов.
    expect(mockCellReads).toBe(3);
  });

  it('не открылось совсем — снимок цел, а повод записан', async () => {
    await draftOnDisk();
    mockReadRefusals = 99;

    expect(await loadComposeDraft(DID)).toBeNull();

    // Стереть его значило бы потерять пост окончательно: он поднимется при
    // следующем запуске либо протухнет сам через полчаса.
    expect(mockKv.has(SCOPED)).toBe(true);
    expect(warns()).toContain('compose_draft_unreadable');
  });

  it('пока свой снимок не прочитан, старую запись вместо него не подставляют', async () => {
    await draftOnDisk();
    legacyOnDisk('пост позапрошлой версии приложения');
    mockReadRefusals = 99;

    // Прежде на экран поднимался черновик времён до v4.32.292 — а публикация
    // следом стёрла бы нынешний как отработанный.
    expect(await loadComposeDraft(DID)).toBeNull();
    expect(mockKv.has(SCOPED)).toBe(true);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: спокойная база как была', () => {
  it('снимок поднимается целиком', async () => {
    await draftOnDisk();

    const snap = await loadComposeDraft(DID);

    expect(snap?.draft).toBe(SNAP.draft);
    expect(snap?.uris).toEqual(SNAP.uris);
    expect(warns()).not.toContain('compose_draft_unreadable');
  });

  it('снимка нет — тихий null, без повода в журнале', async () => {
    expect(await loadComposeDraft(DID)).toBeNull();
    expect(warns()).toEqual([]);
  });

  it('запись до v4.32.292 поднимается и с диска снимается', async () => {
    legacyOnDisk('пост позапрошлой версии приложения');

    expect((await loadComposeDraft(DID))?.draft).toBe('пост позапрошлой версии приложения');
    // Открытый текст на диске оставаться не должен: удаление профиля его не
    // заберёт, ключ не под `p<id>:`.
    expect(mockKv.has(LEGACY)).toBe(false);
  });

  it('свой снимок есть — старая запись только стирается, но не читается', async () => {
    await draftOnDisk();
    legacyOnDisk('пост позапрошлой версии приложения');

    expect((await loadComposeDraft(DID))?.draft).toBe(SNAP.draft);
    expect(mockKv.has(LEGACY)).toBe(false);
  });

  it('ГРАНИЦА: мусор вместо снимка по-прежнему убирают', async () => {
    mockKv.set(SCOPED, 'не json вовсе');

    expect(await loadComposeDraft(DID)).toBeNull();
    expect(mockKv.has(SCOPED)).toBe(false);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  const root = path.join(__dirname, '..', '..', '..');
  const FEED = fs.readFileSync(path.join(root, 'ui', 'screens', 'FeedScreen.tsx'), 'utf8');
  const LOCAL = fs.readFileSync(path.join(root, 'core', 'storage', 'local.ts'), 'utf8');
  const RETRY = fs.readFileSync(path.join(root, 'core', 'storage', 'readRetry.ts'), 'utf8');

  it('восстановление в ленте одноразовое: второго захода не будет', () => {
    const at = FEED.indexOf('const snap = await loadComposeDraft(did);');
    expect(at).toBeGreaterThan(0);
    // Ни одного `null` дальше не ждут — сразу выходят.
    expect(FEED.slice(at, at + 120)).toContain('if (!snap || cancelled) return;');
    // И эффект перезапускается только при смене профиля.
    expect(FEED.slice(at, at + 4000)).toContain('}, [did]);');
  });

  it('`kvGetSecret` по-прежнему сводит «нет» и «не открылось» к одному ответу', () => {
    expect(LOCAL).toContain('export async function kvGetSecret(key: string): Promise<string | null> {\n  return cellTextOrNull(await kvGetSecretCell(key));');
  });

  it('и три состояния у ячейки на месте', () => {
    expect(LOCAL).toContain('export async function kvGetSecretCell(key: string): Promise<AtRestCell> {');
    expect(LOCAL).toContain("  if (read === null) return { state: 'unreadable' };");
  });

  it('паузы конечны и ограничены сверху', () => {
    expect(RETRY).toContain('export const READ_RETRY_ATTEMPTS = 2;');
    expect(RETRY).toContain('export const READ_RETRY_MAX_MS = 600;');
  });
});
