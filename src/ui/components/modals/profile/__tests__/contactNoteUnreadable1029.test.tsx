/**
 * v4.32.1029 — непрочитанная заметка о контакте выдавалась за незаведённую.
 *
 * Дефект. Карточка читала заметку через `kvGetSecretScoped` — тот сводит к
 * `null` три разных ответа: «записи нет», «база не ответила» и «шифртекст не
 * открылся». Дальше `n ?? ''` смешивал их ещё и с пустой строкой, и в строке
 * «Заметка» вставала подпись «Личная заметка — видна только вам» — обещание,
 * что заметки нет.
 *
 * Цена. Две, и обе настоящие.
 *
 * Первая — потеря текста. Отказ базы здесь обыкновенный: карточка открывается
 * поверх диалога, ровно тогда, когда SQLite занята выборкой истории, и
 * `kvTryGet` на занятой базе отвечает `null`. Человек видит «заметки нет»,
 * открывает окно правки — поле пустое, — пишет новую и сохраняет. К этой
 * секунде база уже свободна, `kvUpdateSecretScoped` читает ячейку успешно и
 * записывает: обновлятель здесь `() => draft`, прежнее содержимое он не
 * смотрит. Старая заметка стёрта, и человек об этом не узнал — он был уверен,
 * что стирать нечего.
 *
 * Вторая — застрявшая ячейка. Если шифртекст и правда не открывается (ключ
 * сменился), запись при сохранении отклоняется с `SECRET_UNREADABLE_TEXT` —
 * текст цел. Но кнопка «Удалить» нарисована под `{contactNote ? (`, а
 * `contactNote` пуст: единственный способ убрать негодную запись скрыт. Уйти
 * из этого положения было нечем.
 *
 * Правка. Читается ячейкой (`kvGetSecretCellScoped`), три состояния
 * различаются. Непрочитанная заметка называется непрочитанной — и в строке
 * карточки, и отдельной строкой в окне правки, где сказано прямо: поле ниже —
 * не прежний текст, сохранение его заменит. «Удалить» при этом доступна.
 *
 * Границы. Проверка живая: лист поднимается react-test-renderer'ом, ответы
 * хранилища задаются моком. Тексты сверяются по тому, что видно на экране, а
 * не по исходникам.
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

// Жесты и отступы безопасной зоны к делу не относятся, а их нативных модулей
// в jest нет: AppModal оборачивает содержимое в GestureHandlerRootView.
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
  usePresence: () => ({ bucket: 'never', lastActiveAt: 0, label: '', status: '' }),
}));

/** Что лежит в ячейке заметки на этом прогоне. */
type Cell = { state: 'absent' } | { state: 'plain'; text: string } | { state: 'unreadable' };
let mockCell: Cell = { state: 'absent' };
/** Чем ответит запись. */
let mockUpdateResult: 'written' | 'unchanged' | 'unreadable' | 'failed' = 'written';
const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock('../../../../../core/storage/local', () => ({
  contactNoteKey: (peer: string) => `contact_note:${peer}`,
  kvGetSecretScoped: jest.fn(async () => (mockCell.state === 'plain' ? mockCell.text : null)),
  kvGetSecretCellScoped: jest.fn(async () => mockCell),
  kvUpdateSecretScoped: jest.fn(async (p: number, k: string, up: (c: string | null) => string | null) => {
    mockUpdate(p, k, up(mockCell.state === 'plain' ? mockCell.text : null));
    return mockUpdateResult;
  }),
  kvDeleteScopedChecked: jest.fn(async (p: number, k: string) => {
    mockDelete(p, k);
  }),
  listConversationMedia: jest.fn(async () => []),
  listGroups: jest.fn(async () => []),
  listGroupMembers: jest.fn(async () => []),
  getChatMessageStats: jest.fn(async () => ({ messageCount: 0, sentCount: 0, firstMessageAt: null })),
}));

jest.mock('../../../../../core/settings/privacyPrefs', () => ({
  notifyOnlineGet: jest.fn(async () => false),
  notifyOnlineSet: jest.fn(async () => undefined),
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
const INVITE = 'Личная заметка — видна только вам';

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

async function mount(): Promise<Tree> {
  let tree: Tree | null = null;
  await act(async () => {
    tree = TestRenderer.create(
      <ProfileChatBlock
        peerB64={PEER}
        myPubB64={MINE}
        displayName="Аня"
        activeProfileId={1}
        onOpenMedia={jest.fn()}
      />,
    );
  });
  return tree as unknown as Tree;
}

/**
 * Нажать кнопку с такой надписью. Надпись лежит в `Text`, а нажатие — на
 * обёртке над ним: поднимаемся, пока не найдём того, кто его принимает.
 */
async function pressByLabel(tree: Tree, label: string): Promise<void> {
  let node: Inst | null = tree.root.findByProps({ children: label });
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`нажимать нечего: ${label}`);
  const onPress = node.props.onPress as () => void;
  await act(async () => { onPress(); });
}

/** Открыть окно правки заметки так, как это делает человек. */
async function openNote(tree: Tree): Promise<void> {
  const row = tree.root.findByProps({ testID: 'profile_contact_note' });
  await act(async () => {
    (row.props.onPress as () => void)();
  });
}

let mounted: Tree | null = null;
async function open(): Promise<Tree> {
  mounted = await mount();
  return mounted;
}

beforeEach(() => {
  mockCell = { state: 'absent' };
  mockUpdateResult = 'written';
  mockUpdate.mockClear();
  mockDelete.mockClear();
  mockShowError.mockClear();
  mockShowSuccess.mockClear();
});

afterEach(async () => {
  const t = mounted;
  mounted = null;
  if (t) await act(async () => { t.unmount(); });
});

describe('непрочитанная заметка не выдаётся за незаведённую', () => {
  it('строка карточки говорит, что заметку не прочитали', async () => {
    mockCell = { state: 'unreadable' };
    const t = await open();
    const text = allText(t.toJSON());
    expect(text).not.toContain(INVITE);
    expect(text).toContain('не удалось прочитать');
  });

  it('окно правки предупреждает, что пустое поле — не прежний текст', async () => {
    mockCell = { state: 'unreadable' };
    const t = await open();
    await openNote(t);
    const text = allText(t.toJSON());
    // Иначе человек пишет новую заметку поверх старой, не зная, что она есть.
    expect(text).toContain('заменит');
  });

  it('«Удалить» доступна: негодную запись должно быть чем убрать', async () => {
    mockCell = { state: 'unreadable' };
    const t = await open();
    await openNote(t);
    expect(allText(t.toJSON())).toContain('Удалить');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: обычная заметка ведёт себя как прежде', () => {
  it('прочитанная заметка видна в строке', async () => {
    mockCell = { state: 'plain', text: 'должен 500' };
    const t = await open();
    const text = allText(t.toJSON());
    expect(text).toContain('должен 500');
    expect(text).not.toContain(INVITE);
    expect(text).not.toContain('не удалось прочитать');
  });

  it('прочитанная заметка подставляется в поле правки и даёт «Удалить»', async () => {
    mockCell = { state: 'plain', text: 'должен 500' };
    const t = await open();
    await openNote(t);
    const field = t.root.findByProps({ placeholder: 'Личная заметка (видна только вам)…' });
    expect(field.props.value).toBe('должен 500');
    expect(allText(t.toJSON())).toContain('Удалить');
  });

  it('заметки нет — строка приглашает завести, «Удалить» не предлагается', async () => {
    const t = await open();
    await openNote(t);
    const text = allText(t.toJSON());
    expect(text).toContain(INVITE);
    expect(text).not.toContain('Удалить');
    expect(text).not.toContain('не удалось прочитать');
  });

  it('ГРАНИЦА: пустая заметка — это отсутствие, а не беда', async () => {
    mockCell = { state: 'plain', text: '' };
    const t = await open();
    const text = allText(t.toJSON());
    expect(text).toContain(INVITE);
    expect(text).not.toContain('не удалось прочитать');
  });

  it('сохранение заметки по-прежнему доходит до хранилища', async () => {
    const t = await open();
    await openNote(t);
    const field = t.root.findByProps({ placeholder: 'Личная заметка (видна только вам)…' });
    await act(async () => { (field.props.onChangeText as (v: string) => void)(' встреча в пятницу '); });
    await pressByLabel(t, 'Сохранить');
    expect(mockUpdate).toHaveBeenCalledWith(1, `contact_note:${PEER}`, 'встреча в пятницу');
    expect(mockShowSuccess).toHaveBeenCalledWith('Заметка сохранена');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('строчное чтение и правда сводит нечитаемость к «записи нет»', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'storage', 'local.ts'),
      'utf8',
    );
    expect(src).toContain('return cellTextOrNull(await kvGetSecretCellScoped(profileId, key));');
    expect(src).toContain("if (read === null) return { state: 'unreadable' };");
  });

  it('запись не смотрит на прежнее содержимое — заменить есть чему', async () => {
    // Обновлятель в карточке — `() => draft`: прежний текст он не читает. Значит
    // «показали пусто» и «стёрли старое» разделяет ровно один вопрос к базе,
    // заданный на секунду раньше.
    mockCell = { state: 'plain', text: 'прежняя заметка' };
    const t = await open();
    await openNote(t);
    const field = t.root.findByProps({ placeholder: 'Личная заметка (видна только вам)…' });
    await act(async () => { (field.props.onChangeText as (v: string) => void)('новая'); });
    await pressByLabel(t, 'Сохранить');
    expect(mockUpdate).toHaveBeenCalledWith(1, `contact_note:${PEER}`, 'новая');
  });

  it('удаление работает по ключу, а не по содержимому: негодную ячейку оно уносит', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'storage', 'local.ts'),
      'utf8',
    );
    const at = src.indexOf('export async function kvDeleteScopedChecked(profileId: number, key: string)');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 220)).toContain('kvDeleteChecked(profileScopedKey(profileId, key))');
  });

  it('отказ записи по-прежнему признаётся словами', async () => {
    mockCell = { state: 'unreadable' };
    mockUpdateResult = 'unreadable';
    const t = await open();
    await openNote(t);
    await pressByLabel(t, 'Сохранить');
    expect(mockShowError).toHaveBeenCalled();
    expect(mockShowSuccess).not.toHaveBeenCalled();
  });
});

describe('ЗАКРЕПКА: карточка спрашивает ячейкой', () => {
  it('строчное чтение из карточки ушло', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'ProfileChatBlock.tsx'), 'utf8');
    expect(src).toContain('kvGetSecretCellScoped(activeProfileId, m.contactNoteKey(peerB64))');
    expect(src).not.toContain('kvGetSecretScoped(');
  });

  it('удачное сохранение снимает пометку о непрочитанном', async () => {
    mockCell = { state: 'unreadable' };
    const t = await open();
    await openNote(t);
    mockUpdateResult = 'written';
    const field = t.root.findByProps({ placeholder: 'Личная заметка (видна только вам)…' });
    await act(async () => { (field.props.onChangeText as (v: string) => void)('новая'); });
    await pressByLabel(t, 'Сохранить');
    const text = allText(t.toJSON());
    expect(text).toContain('новая');
    expect(text).not.toContain('не удалось прочитать');
  });

  it('удачное удаление тоже снимает пометку', async () => {
    mockCell = { state: 'unreadable' };
    const t = await open();
    await openNote(t);
    await pressByLabel(t, 'Удалить');
    expect(mockDelete).toHaveBeenCalledWith(1, `contact_note:${PEER}`);
    expect(allText(t.toJSON())).not.toContain('не удалось прочитать');
  });
});
