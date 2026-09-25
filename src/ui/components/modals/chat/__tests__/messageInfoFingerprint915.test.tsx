/**
 * Окно сведений звало CID-ом то, что им не является (v4.32.915).
 *
 * Дефект. Нижняя строка окна печаталась одной формулой на любое значение:
 *
 *     <Text …>CID: {msg.cid.slice(0, 32)}…</Text>
 *
 * А `msg.cid` хранит не только CID. Путь отправки кладёт туда `local:<время>`
 * для заметки себе (messaging.ts, «строка никуда не отправлялась, и настоящего
 * CID у неё нет») и `fallback:<id сообщения>` для всего, что ушло по локальной
 * сети, через WebRTC или через реле. На телефоне IPFS выключен, поэтому
 * `fallback:` — не редкость, а обычный случай: окно показывало
 * «CID: fallback:7f3c…» подавляющему большинству отправленного.
 *
 * Цена. Три разные, и только третья — косметика.
 *   • Ложь. «CID» означает адрес содержимого в сети; `fallback:<uuid>` — это
 *     местный заполнитель, который сам же код запрещает писать как ссылку
 *     (v4.32.128: «NEVER write fallback:/lan: refs to conversation tip»).
 *     Человек, открывший сведения, чтобы понять, ушло ли сообщение наружу,
 *     получал утверждение, что оно опубликовано.
 *   • Бесполезность. Строку обрезали многоточием и не давали ни выделить, ни
 *     скопировать — а к идентификатору приходят именно за этим.
 *   • Слово. «CID» — единственное непереведённое слово в окне, где соседние
 *     строки переведены нарочно: маршруты в v4.32.563, состояния в v4.32.886,
 *     счётчики в v4.32.909.
 *
 * Правка. Строка есть только у настоящего CID (`isPlainCid`, дом с v4.32.432),
 * зовётся «Отпечаток в сети», сокращается общедомовым `shortIdentity` и
 * копируется нажатием.
 *
 * Развилка «отправлено / в очереди» осталась на `!!msg.cid`: `fallback:` — это
 * честное «ушло с устройства», и прятать надо не состояние, а ложную подпись.
 */
import React, { act } from 'react';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TestRenderer = require('react-test-renderer') as {
  create: (element: React.ReactElement) => {
    root: {
      findAllByProps: (p: Record<string, unknown>) => Array<{ props: Record<string, unknown> }>;
    };
    toJSON: () => unknown;
    unmount: () => void;
  };
};

// Жесты здесь ни при чём, а их нативный модуль в jest не живёт: AppModal
// оборачивает содержимое в GestureHandlerRootView.
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

// Имя с приставкой mock — иначе babel не пустит переменную в фабрику jest.mock.
const mockSetString = jest.fn(async (_text: string) => true);
jest.mock('expo-clipboard', () => ({ setStringAsync: (s: string) => mockSetString(s) }));

import type { ChatMessageRow } from '../../../../../core/storage/local';
import { MessageInfoModal } from '../ChatMessageInfoModal';
import { isPlainCid } from '../../../../../core/cid';
import { shortIdentity } from '../../../../identity/shortId';
import { COPIED_TEXT, COPY_FINGERPRINT_ACTION } from '../../../../clipboardText';

type Tree = ReturnType<typeof TestRenderer.create>;

/** Настоящий CIDv1 base32 — 59 знаков, как их отдаёт шлюз. */
const REAL_CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
/** Заполнитель, который кладёт путь отправки, когда IPFS не участвовал. */
const FALLBACK = 'fallback:7f3c1d20-9a44-4e18-8b21-0c5a6e3f9d10';
/** Заметка себе: не отправлялась вовсе. */
const LOCAL = 'local:1700000000000';

function row(status: string, cid: string | null): ChatMessageRow {
  return {
    id: 'm-915',
    text: 'Привет',
    direction: 'out',
    status,
    cid,
    createdAt: 1_700_000_000_000,
  } as unknown as ChatMessageRow;
}

function texts(tree: Tree): string[] {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (typeof n === 'string') {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (n && typeof n === 'object') walk((n as { children?: unknown }).children);
  };
  walk(tree.toJSON());
  return out;
}

/** Всё, что окно показало, одной строкой — для проверок «нигде не встречается». */
const joined = (tree: Tree): string => texts(tree).join('\n');

function open(msg: ChatMessageRow): Tree {
  let tree: Tree | null = null;
  act(() => {
    tree = TestRenderer.create(<MessageInfoModal msg={msg} onClose={jest.fn()} />);
  });
  return tree as unknown as Tree;
}

function close(tree: Tree): void {
  act(() => {
    tree.unmount();
  });
}

beforeEach(() => {
  mockSetString.mockClear();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('окно вообще открывается — иначе проверки на отсутствие пусты', () => {
    const t = open(row('sent', REAL_CID));
    expect(texts(t)).toContain('Сведения о сообщении');
    expect(texts(t).length).toBeGreaterThan(5);
    close(t);
  });

  it('заполнители и правда доходили до окна — они приходят из пути отправки', () => {
    // Повод для правки: значения не выдуманы, их кладёт messaging.ts.
    expect(isPlainCid(REAL_CID)).toBe(true);
    expect(isPlainCid(FALLBACK)).toBe(false);
    expect(isPlainCid(LOCAL)).toBe(false);
  });
});

describe('окно показывает отпечаток только тогда, когда он есть', () => {
  it('у настоящего CID строка есть и зовётся по-русски', () => {
    const t = open(row('sent', REAL_CID));
    expect(texts(t)).toContain('Отпечаток в сети');
    expect(COPY_FINGERPRINT_ACTION).toBe('Копировать отпечаток');
    close(t);
  });

  it('у заметки себе строки отпечатка нет и слова «local:» тоже', () => {
    const t = open(row('delivered', LOCAL));
    expect(joined(t)).not.toContain('local:');
    expect(texts(t)).not.toContain('Отпечаток в сети');
    close(t);
  });

  it('у ушедшего мимо сети — тоже нет, и «fallback:» не показывают', () => {
    const t = open(row('sent', FALLBACK));
    expect(joined(t)).not.toContain('fallback:');
    expect(texts(t)).not.toContain('Отпечаток в сети');
    close(t);
  });

  it('слова «CID» в окне не осталось ни при одном значении', () => {
    for (const cid of [REAL_CID, FALLBACK, LOCAL, null]) {
      const t = open(row('sent', cid));
      expect(joined(t)).not.toContain('CID');
      close(t);
    }
  });

  it('настоящий CID показан обоими концами, а не одной головой', () => {
    const t = open(row('sent', REAL_CID));
    const shown = shortIdentity(REAL_CID, 10);
    expect(texts(t)).toContain(shown);
    expect(shown).toBe('bafybeigdy…tqy55fbzdi');
    // Прежняя форма: тридцать два знака с головы и многоточие.
    expect(joined(t)).not.toContain(REAL_CID.slice(0, 32) + '…');
    close(t);
  });

  it('нажатие кладёт в буфер CID целиком, а не то, что видно', () => {
    const t = open(row('sent', REAL_CID));
    const [pressable] = t.root.findAllByProps({ accessibilityLabel: COPY_FINGERPRINT_ACTION });
    expect(pressable).toBeTruthy();
    act(() => {
      (pressable.props.onPress as () => void)();
    });
    expect(mockSetString).toHaveBeenCalledWith(REAL_CID);
    close(t);
  });
});

describe('до правки было верно и осталось верно', () => {
  it('«ушло с устройства» по-прежнему считается по любой ссылке', () => {
    // Заполнитель — честное «ушло»: по локальной сети или через реле оно ушло
    // не менее честно, чем в IPFS. Пряталась ложная подпись, а не состояние.
    const f = open(row('sent', FALLBACK));
    expect(texts(f)).toContain('Отправлено');
    close(f);
    const q = open(row('sent', null));
    expect(texts(q)).toContain('В очереди на отправку');
    close(q);
  });

  it('остальные строки окна не тронуты', () => {
    const t = open(row('read', REAL_CID));
    const seen = texts(t);
    expect(seen).toContain('Сведения о сообщении');
    expect(seen).toContain('Прочитано');
    expect(seen).toContain('символов');
    close(t);
  });

  it('подтверждение копирования — общее домовое, а не тринадцатое своё', () => {
    // Слово для озвучки завелось новое, а подтверждение взято готовое: в буфер
    // ложится строка, и «Скопировано» стоит в доме с v4.32.469.
    expect(COPIED_TEXT).toBe('Скопировано');
  });

  it('сокращение берётся у дома и многоточие ставит только по делу', () => {
    // Правило v4.32.425: короткое значение возвращается целиком — подпись не
    // обещает продолжения, которого нет.
    expect(shortIdentity('bafy915', 10)).toBe('bafy915');
    expect(shortIdentity(REAL_CID, 10)).toContain('…');
  });
});
