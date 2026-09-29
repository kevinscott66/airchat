/**
 * ДЕФЕКТ (v4.32.1064). Непрочитанный альбом историй выдавался за пустой — и
 * оставлял одно доступное действие, необратимое.
 *
 * `listStoryAlbumItems(...).catch(log.warn)` гасил отказ базы и оставлял
 * `items` пустым массивом, то есть тем же самым, чем отвечает по-настоящему
 * пустой альбом. Экран писал «0 историй» и «Альбом пуст. Откройте „Все
 * истории“…», хотя плашка того же альбома рядом показывала свой счётчик из
 * другого запроса — скажем, 12. То же самое делал `listStoryAlbums`: первый
 * отказ оставлял полосу пустой, будто альбомов нет вовсе. Соседи в том же
 * эффекте отказ различают (`shouldApplyRows` у стены, отдельный `.catch` у
 * живых историй) — до альбомов это не дошло.
 *
 * ЦЕНА. Не в надписи. «Убрать из альбома» живёт на плитках, а плиток нет:
 * единственное, что остаётся нажать, — сама плашка, а второе нажатие по ней
 * открывает меню, где второй строкой стоит «Удалить альбом» без переспроса.
 * Альбом хранит СВОИ копии снимков (в этом вся его задумка: история истекает
 * через сутки, копия остаётся), и другого места, где на эти копии есть
 * ссылка, нет — что и сказано в самом обработчике. Человек, которому показали
 * пустой альбом, удаляет пустышку и получает «Альбом удалён вместе с копиями
 * снимков». Восстановить нечем. Отказ базы тут обыкновенный: карточка
 * профиля открывается поверх ленты, ровно когда SQLite занята.
 *
 * Вторая половина — полоса. С непрочитанным списком лист «В альбом» предлагал
 * один «Новый альбом…», а `takenTitles` пустел, и `albumTitleProblem`
 * переставал ловить совпадения: человек заводил второй альбом с тем же
 * названием поверх невидимого первого.
 *
 * ПРАВКА. У обоих чтений три состояния (`Read<T>`: reading | failed | ready).
 * Непрочитанный альбом говорит «Альбом не прочитался. Снимки на месте», не
 * пишет «0 историй» и не предлагает «Удалить альбом». Непрочитанная полоса
 * говорит «Альбомы не прочитались» и не предлагает завести новый. Прочитанное
 * однажды при следующем отказе остаётся на месте: устаревшее честнее
 * выдуманного.
 *
 * ГРАНИЦЫ. По-настоящему пустой альбом пишет «Альбом пуст» как и писал, и
 * удалить его по-прежнему можно. Пустая прочитанная полоса по-прежнему
 * предлагает «Альбом». Удаление, когда оно предложено, работает как работало.
 */
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
type Inst = { props: Record<string, unknown> };
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => {
    root: {
      findByProps: (p: Record<string, unknown>) => Inst;
      findAllByProps: (p: Record<string, unknown>) => Inst[];
    };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaProvider: RN.View,
    SafeAreaView: RN.View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets },
  };
});

type Row = Record<string, unknown>;

/** Чем отвечают оба чтения на этом прогоне. `null` — отказ базы. */
const store = {
  albums: null as Row[] | null,
  items: null as Row[] | null,
  stories: [] as Row[],
  removedAlbums: [] as string[],
};

jest.mock('../../../../../core/storage/local', () => ({
  listActiveStories: jest.fn(async () => store.stories),
  listStoryAlbums: jest.fn(async () => {
    if (store.albums === null) throw new Error('db_busy');
    return store.albums;
  }),
  listStoryAlbumItems: jest.fn(async () => {
    if (store.items === null) throw new Error('db_busy');
    return store.items;
  }),
  renameStoryAlbum: jest.fn(async () => undefined),
}));

jest.mock('../../../../../core/social/storyAlbums', () => ({
  addStoryToAlbum: jest.fn(async () => 'ok'),
  albumItemLocalUri: jest.fn(async () => null),
  createStoryAlbum: jest.fn(async () => 'new_album'),
  removeStoryAlbum: jest.fn(async (id: string) => { store.removedAlbums.push(id); }),
  removeStoryFromAlbum: jest.fn(async () => undefined),
}));

jest.mock('../../../../../core/social/feedService', () => ({
  listArchivedFeedPosts: jest.fn(async () => []),
  loadFeedPosts: jest.fn(async () => []),
  resolveFeedMediaUris: jest.fn(async () => ({})),
}));

jest.mock('../../../../../core/config', () => ({
  getConfigSync: () => ({ cloudBackup: { enabled: false } }),
  loadConfig: jest.fn(async () => ({ ipfs: { gatewayUrl: 'https://gw.example/' } })),
}));

/** Лист действий наружу не рисуем: нужен сам его состав. */
type Sheet = { title: string; options: { label: string }[] } | null;
const mockSheets: Sheet[] = [];
jest.mock('../../../ActionSheet', () => ({
  ActionSheet: ({ state }: { state: Sheet }) => {
    mockSheets.push(state);
    return null;
  },
}));

import { ProfilePostsPane } from '../ProfilePostsModal';

const MINE = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

type Tree = ReturnType<typeof TestRenderer.create>;

/** Весь видимый текст дерева одной строкой: экран смотрят целиком. */
function allText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(allText).join('\u0001');
  if (node && typeof node === 'object' && 'children' in node) {
    return allText((node as { children: unknown }).children);
  }
  return '';
}

const album = (id: string, title: string, count: number): Row => ({
  id, title, createdAt: 1, count, coverFile: null,
});

const item = (id: string, text: string): Row => ({
  id, albumId: 'a1', mediaFile: `${id}.jpg`, mediaCid: null,
  mediaType: 'image', text, createdAt: 1, addedAt: 2,
});

const story = (id: string, text: string): Row => ({
  id, authorPubB64: MINE, mediaUri: null, mediaType: 'image', text,
  expiresAt: Date.now() + 1000, viewedBy: null, ownerProfileId: 1, createdAt: 1,
});

let mounted: Tree | null = null;

async function open(): Promise<Tree> {
  await act(async () => {
    mounted = TestRenderer.create(
      <ProfilePostsPane
        active
        mode="stories"
        isSelf
        authorDid="did:key:me"
        authorPubB64={MINE}
        ownerProfileId={1}
      />,
    );
  });
  return mounted as unknown as Tree;
}

/** Нажать на плашку альбома по её подписи. */
async function tapChip(tree: Tree, title: string): Promise<void> {
  const chip = tree.root.findByProps({ accessibilityLabel: `Альбом ${title}` });
  await act(async () => { (chip.props.onPress as () => void)(); });
}

/** Нажать на что-нибудь с такой подписью; `null` — такого на экране нет. */
async function tapLabel(tree: Tree, label: string): Promise<boolean> {
  const found = tree.root.findAllByProps({ accessibilityLabel: label })
    .filter((n) => typeof n.props.onPress === 'function');
  if (found.length === 0) return false;
  await act(async () => { (found[0].props.onPress as () => void)(); });
  return true;
}

/** Есть ли на экране нажимаемое с такой подписью. */
function has(tree: Tree, label: string): boolean {
  return tree.root.findAllByProps({ accessibilityLabel: label })
    .some((n) => typeof n.props.onPress === 'function');
}

/** Состав последнего показанного листа действий. */
function lastSheet(): Sheet {
  for (let i = mockSheets.length - 1; i >= 0; i -= 1) {
    if (mockSheets[i] !== null) return mockSheets[i];
  }
  return null;
}

beforeEach(() => {
  store.albums = [album('a1', 'Лето', 12)];
  store.items = [item('i1', 'Первая'), item('i2', 'Вторая')];
  store.stories = [];
  store.removedAlbums = [];
  mockSheets.length = 0;
});

afterEach(async () => {
  const t = mounted;
  mounted = null;
  if (t) await act(async () => { t.unmount(); });
});

describe('непрочитанный альбом не выдаётся за пустой', () => {
  it('вместо «Альбом пуст» сказано, что его не прочитали', async () => {
    const t = await open();
    store.items = null;
    await tapChip(t, 'Лето');

    const text = allText(t.toJSON());
    expect(text).toContain('не прочитался');
    expect(text).not.toContain('Альбом пуст');
  });

  it('счётчик «0 историй» не появляется: счёта нет', async () => {
    const t = await open();
    store.items = null;
    await tapChip(t, 'Лето');

    // Рядом на плашке стоит 12 из другого запроса — «0 историй» под ней
    // означало бы, что одиннадцать с лишним снимков только что пропали.
    expect(allText(t.toJSON())).not.toContain('0 историй');
  });

  it('«Удалить альбом» не предлагается, пока неизвестно, что внутри', async () => {
    const t = await open();
    store.items = null;
    await tapChip(t, 'Лето');
    // Второе нажатие по плашке открытого альбома — это меню. Оно и было
    // единственным, что оставалось нажать: плиток с «Убрать из альбома» нет.
    await tapChip(t, 'Лето');

    const labels = (lastSheet()?.options ?? []).map((o) => o.label);
    expect(labels).not.toContain('Удалить альбом');
    expect(labels).toContain('Переименовать');
  });

  it('плитки прежнего альбома не остаются за новым', async () => {
    store.albums = [album('a1', 'Лето', 12), album('a2', 'Зима', 3)];
    const t = await open();
    await tapChip(t, 'Лето');
    expect(allText(t.toJSON())).toContain('Первая');

    store.items = null;
    await tapChip(t, 'Зима');

    // Иначе снимки одного альбома показывались бы как содержимое другого —
    // и «Удалить» уносило бы не то, что на экране.
    expect(allText(t.toJSON())).not.toContain('Первая');
  });
});

describe('непрочитанная полоса не выдаётся за «альбомов нет»', () => {
  it('полоса говорит, что не прочиталась', async () => {
    store.albums = null;
    const t = await open();

    expect(allText(t.toJSON())).toContain('Альбомы не прочитались');
  });

  it('новый альбом заводить не предлагают: сверять название не с чем', async () => {
    store.albums = null;
    const t = await open();

    // `takenTitles` берётся из этого же списка: пустой — и
    // `albumTitleProblem` перестаёт ловить совпадения. Второй «Лето» лёг бы
    // поверх невидимого первого.
    expect(has(t, 'Новый альбом')).toBe(false);
  });

  it('нажатие на историю не предлагает единственный «Новый альбом…»', async () => {
    store.albums = null;
    store.stories = [story('s1', 'Вчерашняя')];
    const t = await open();

    expect(await tapLabel(t, 'Вчерашняя')).toBe(true);
    expect(lastSheet()).toBeNull();
    expect(allText(t.toJSON())).toContain('Альбомы не прочитались');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прочитанное показывается как раньше', () => {
  it('альбом с двумя историями так и говорит', async () => {
    const t = await open();
    await tapChip(t, 'Лето');

    const text = allText(t.toJSON());
    expect(text).toContain('2 истории');
    expect(text).toContain('Первая');
    expect(text).toContain('Вторая');
  });

  it('ГРАНИЦА: по-настоящему пустой альбом пишет «Альбом пуст»', async () => {
    store.items = [];
    const t = await open();
    await tapChip(t, 'Лето');

    expect(allText(t.toJSON())).toContain('Альбом пуст');
  });

  it('ГРАНИЦА: прочитанная пустая полоса предлагает завести альбом', async () => {
    store.albums = [];
    const t = await open();

    expect(has(t, 'Новый альбом')).toBe(true);
    expect(allText(t.toJSON())).not.toContain('Альбомы не прочитались');
  });

  it('ГРАНИЦА: прочитанный альбом удаляется как и прежде', async () => {
    const t = await open();
    await tapChip(t, 'Лето');
    await tapChip(t, 'Лето');

    const del = (lastSheet()?.options ?? []).find((o) => o.label === 'Удалить альбом');
    expect(del).toBeDefined();
    await act(async () => { (del as unknown as { onPress: () => void }).onPress(); });
    await act(async () => { /* ждём асинхронное удаление */ });

    expect(store.removedAlbums).toEqual(['a1']);
    expect(allText(t.toJSON())).toContain('Альбом удалён вместе с копиями снимков.');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: удаление и правда уносит снимки', () => {
  it('единственная копия снимка живёт в самом альбоме', () => {
    // Если однажды копии переедут туда, откуда их можно достать обратно,
    // проверка упадёт и потребует пересмотреть саму постановку: цена
    // ошибочного «пусто» тогда станет другой.
    const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
    const { join } = jest.requireActual('path') as typeof import('path');
    const src = readFileSync(join(__dirname, '..', 'ProfilePostsModal.tsx'), 'utf8');
    expect(src).toContain('Альбом удалён вместе с копиями снимков.');
    expect(src).toContain('другого места, где на них');
  });

  it('«Убрать из альбома» живёт только на плитках', () => {
    // Потому пропавшие плитки и оставляют одно действие — удаление целиком.
    const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
    const { join } = jest.requireActual('path') as typeof import('path');
    const src = readFileSync(join(__dirname, '..', 'ProfilePostsModal.tsx'), 'utf8');
    const at = src.indexOf('const onItemPress');
    const to = src.indexOf('const onAlbumMenu');
    expect(at).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(at);
    expect(src.slice(at, to)).toContain("label: 'Убрать из альбома'");
    expect(src.slice(to)).not.toContain("label: 'Убрать из альбома'");
  });
});
