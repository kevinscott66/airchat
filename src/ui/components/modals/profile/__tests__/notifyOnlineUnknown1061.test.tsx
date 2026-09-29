/**
 * ДЕФЕКТ (v4.32.1061). Непрочитанная просьба «сообщить, когда появится»
 * выдавалась за неподанную.
 *
 * `notifyOnlineGet` читала обе строки через `kvGet`, а тот гасит ошибку базы
 * и отвечает `null` — ровно тем же, чем отвечает нетронутая просьба. Ветка
 * `.catch` у карточки с подписью «настройка неизвестна — считаем выключенной»
 * не срабатывала ни разу: бросать было нечему. Соседние
 * `privacyPrefTryGetFor` и `privacyPrefTryBoolFor` в том же файле заведены
 * под это с v4.32.474 — сюда они не дошли.
 *
 * ЦЕНА. Не в надписи. Просьба одноразовая, и карточка, решив, что её нет,
 * разворачивает нажатие в другую сторону: человек, пришедший просьбу
 * отменить, жал кнопку — и записывал её заново, с тостом «Уведомим, когда
 * появится». Отменить было нечем: единственная кнопка при каждом нажатии
 * ставила просьбу. А уведомление о появлении приходило потом — когда человек
 * был уверен, что отписался. Отказ базы здесь обыкновенный: карточка
 * открывается поверх переписки, ровно тогда, когда SQLite занята выборкой
 * истории.
 *
 * ПРАВКА. Чтение трёхзначное (`kvTryGet`, `null` — не прочитали). Карточка
 * говорит «не удалось прочитать» и предлагает нажать ещё раз: нажатие в этом
 * положении перечитывает, а не переключает. Экран переписки при незнании
 * молчит намеренно — уведомление о человеке, про которого, может быть, никто
 * не просил, хуже пропущенного; просьба остаётся лежать и сработает в
 * следующий раз.
 *
 * ГРАНИЦЫ. Прочитанная просьба работает как прежде: и включённая, и снятая.
 * Разделение по аккаунтам (v4.32.311) не тронуто.
 */
import React, { act } from 'react';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
// eslint-disable-next-line @typescript-eslint/no-require-imports
type Inst = { props: Record<string, unknown>; parent: Inst | null };
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => {
    root: { findByProps: (p: Record<string, unknown>) => Inst };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

jest.mock('react-native-gesture-handler', () => {
  const RN = jest.requireActual('react-native');
  return { GestureHandlerRootView: RN.View };
});
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

jest.mock('../../../../hooks/usePresence', () => ({
  usePresence: () => ({ bucket: 'offline', lastActiveAt: 0, label: 'был(а) недавно', status: '' }),
}));

jest.mock('../../../../../core/storage/local', () => ({
  contactNoteKey: (peer: string) => `contact_note:${peer}`,
  kvGetSecretScoped: jest.fn(async () => null),
  kvGetSecretCellScoped: jest.fn(async () => ({ state: 'absent' })),
  kvUpdateSecretScoped: jest.fn(async () => 'written'),
  kvDeleteScopedChecked: jest.fn(async () => undefined),
  listConversationMedia: jest.fn(async () => []),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => []),
  getChatMessageStats: jest.fn(async () => ({ messageCount: 0, sentCount: 0, firstMessageAt: null })),
}));

/** Что ответит хранилище просьбы на этом прогоне. */
const store = { read: null as boolean | null, writes: [] as boolean[], writeOk: true };
jest.mock('../../../../../core/settings/privacyPrefs', () => ({
  notifyOnlineGet: jest.fn(async () => store.read),
  notifyOnlineSet: jest.fn(async (_peer: string, on: boolean) => {
    store.writes.push(on);
    return store.writeOk;
  }),
}));

const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
jest.mock('../../../userFeedback', () => ({
  showError: (t: string) => mockShowError(t),
  showSuccess: (t: string) => mockShowSuccess(t),
  showInfo: jest.fn(),
}));

import { ProfileChatBlock } from '../ProfileChatBlock';

const PEER = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');
const MINE = Buffer.from(new Uint8Array(32).fill(6)).toString('base64');

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

let mounted: Tree | null = null;

async function open(): Promise<Tree> {
  await act(async () => {
    mounted = TestRenderer.create(
      <ProfileChatBlock
        peerB64={PEER}
        myPubB64={MINE}
        displayName="Аня"
        activeProfileId={1}
        onOpenMedia={jest.fn()}
      />,
    );
  });
  return mounted as unknown as Tree;
}

async function tapNotify(tree: Tree): Promise<void> {
  const row = tree.root.findByProps({ testID: 'profile_notify_online' });
  await act(async () => { (row.props.onPress as () => void)(); });
}

function notifyRow(tree: Tree): Inst {
  return tree.root.findByProps({ testID: 'profile_notify_online' });
}

beforeEach(() => {
  store.read = false;
  store.writes = [];
  store.writeOk = true;
  mockShowError.mockClear();
  mockShowSuccess.mockClear();
});

afterEach(async () => {
  const t = mounted;
  mounted = null;
  if (t) await act(async () => { t.unmount(); });
});

describe('непрочитанная просьба не выдаётся за неподанную', () => {
  it('строка говорит, что просьбу не прочитали', async () => {
    store.read = null;
    const t = await open();
    const text = allText(t.toJSON());
    expect(text).toContain('не удалось прочитать');
    expect(text).not.toContain('Уведомить когда онлайн');
  });

  it('нажатие в незнании перечитывает, а не подаёт просьбу заново', async () => {
    store.read = null;
    const t = await open();
    await tapNotify(t);
    // Вот она, цена: вслепую нажатие уходило в «попросить», и отменить
    // просьбу было нечем — кнопка при каждом нажатии ставила её снова.
    expect(store.writes).toEqual([]);
  });

  it('перечитали удачно — карточка показывает настоящее положение', async () => {
    store.read = null;
    const t = await open();
    store.read = true;
    await tapNotify(t);
    expect(allText(t.toJSON())).toContain('Уведомление: онлайн вкл.');
    expect(store.writes).toEqual([]);
  });

  it('перечитали и снова не вышло — говорим об этом, положение прежнее', async () => {
    store.read = null;
    const t = await open();
    await tapNotify(t);
    expect(mockShowError).toHaveBeenCalledWith('Не удалось прочитать');
    expect(allText(t.toJSON())).toContain('не удалось прочитать');
  });

  it('после удачного перечитывания кнопка снова переключает', async () => {
    store.read = null;
    const t = await open();
    store.read = true;
    await tapNotify(t);
    await tapNotify(t);
    // Просьба была включена — второе нажатие снимает её, как и всегда.
    expect(store.writes).toEqual([false]);
  });

  it('незрячему говорят то же самое', async () => {
    store.read = null;
    const t = await open();
    expect(String(notifyRow(t).props.accessibilityHint)).toContain('попробовать снова');
  });
});

describe('ГРАНИЦА: прочитанная просьба работает как прежде', () => {
  it('просьбы нет — приглашение попросить, нажатие просит', async () => {
    store.read = false;
    const t = await open();
    expect(allText(t.toJSON())).toContain('Уведомить когда онлайн');
    await tapNotify(t);
    expect(store.writes).toEqual([true]);
    expect(mockShowSuccess).toHaveBeenCalled();
  });

  it('просьба стоит — так и написано, нажатие снимает', async () => {
    store.read = true;
    const t = await open();
    expect(allText(t.toJSON())).toContain('Уведомление: онлайн вкл.');
    await tapNotify(t);
    expect(store.writes).toEqual([false]);
  });

  it('запись не легла — переключатель возвращается назад', async () => {
    store.read = false;
    store.writeOk = false;
    const t = await open();
    await tapNotify(t);
    expect(mockShowError).toHaveBeenCalledWith('Не удалось изменить уведомление');
    expect(allText(t.toJSON())).toContain('Уведомить когда онлайн');
  });

  it('ГРАНИЦА: обещания «получите уведомление» в незнании не даём', async () => {
    // Прошло бы и до правки — но именно это обещание и не должно было
    // появиться вместе с новой подписью.
    store.read = null;
    const t = await open();
    expect(allText(t.toJSON())).not.toContain('Получите уведомление при входе');
  });

  it('подсказки о незнании у прочитанной просьбы нет', async () => {
    store.read = false;
    const t = await open();
    expect(notifyRow(t).props.accessibilityHint).toBeUndefined();
    expect(allText(t.toJSON())).not.toContain('попробовать снова');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: просьба одноразовая — оттого и разворот нажатия', async () => {
    // Если бы просьба была обычным переключателем, лишнее нажатие ничего не
    // стоило бы. Она снимается сама при срабатывании, и «включить ещё раз»
    // вместо «отменить» — не то же самое.
    const chat = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', '..', '..', 'screens', 'ChatScreen.tsx'),
      'utf8',
    ) as string;
    expect(chat).toContain('await notifyOnlineSet(peerB64, false)');
  });

  it('ЗАКРЕПКА: экран переписки при незнании молчит и пишет об этом в журнал', () => {
    const chat = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', '..', '..', 'screens', 'ChatScreen.tsx'),
      'utf8',
    ) as string;
    expect(chat).toContain('const asked = await notifyOnlineGet(peerB64);');
    expect(chat).toContain("log.warn('ui_notify_online_unreadable'");
    expect(chat).toContain('if (asked === null) {');
  });
});
