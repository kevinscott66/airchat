/**
 * v4.32.886 — окно сведений называло неотправленное отправленным.
 *
 * Дефект. Состояние сообщения в «Сведениях» считалось тремя словами: всё, что
 * не «Прочитано» и не «Доставлено», получало подпись «Отправлено» и галочку.
 * А состояний у исходящего пять: очередь, отправляется, отправлено,
 * доставлено, прочитано — плюс отказ. Пузырь их различает с самого начала
 * (часы, крутилка, галочка, две галочки, красный кружок «нажмите для
 * повтора»), и таблица у него есть.
 *
 * Цена. Человек открывает сведения ровно тогда, когда что-то пошло не так.
 * У сообщения, которое в двух сантиметрах выше горит красным и никуда не
 * ушло, окно писало «Отправлено» — да ещё и время «отправки» рядом. Это не
 * недосказанность, а прямое противоречие соседнему экрану: поверив ему,
 * повтор не нажмут и сообщение не уйдёт никогда.
 *
 * Правка. Окно берёт те же слова, что и иконка, и различает те же поводы:
 * «отправлено» без CID — ещё очередь, отказ называется отказом, а время
 * создания у неотправленного больше не подписано «Отправлено».
 */
import React, { act } from 'react';
import fs from 'fs';
import path from 'path';

// react-test-renderer приходит с jest-expo; деклараций типов в проекте нет.
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

import type { ChatMessageRow } from '../../../../../core/storage/local';
import { MessageInfoModal } from '../ChatMessageInfoModal';

type Tree = ReturnType<typeof TestRenderer.create>;

/** Исходящая строка переписки в нужном состоянии. */
function row(status: string, cid: string | null = null): ChatMessageRow {
  return {
    id: 'm-886',
    text: 'Привет',
    direction: 'out',
    status,
    cid,
    createdAt: 1_700_000_000_000,
  } as unknown as ChatMessageRow;
}

/** Все строки, показанные в окне. */
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

function open(msg: ChatMessageRow): Tree {
  let tree: Tree | null = null;
  act(() => {
    tree = TestRenderer.create(<MessageInfoModal msg={msg} onClose={jest.fn()} />);
  });
  return tree as unknown as Tree;
}

/** Есть ли в окне значок с таким именем. */
function hasIcon(tree: Tree, name: string): boolean {
  return tree.root.findAllByProps({ name }).length > 0;
}

const SRC = (...p: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', ...p), 'utf8');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('окно вообще открывается и показывает свой заголовок', () => {
    const t = open(row('read'));
    expect(texts(t)).toContain('Сведения о сообщении');
    t.unmount();
  });

  it('прочитанное и доставленное окно называло верно и до правки', () => {
    const r = open(row('read'));
    expect(texts(r)).toContain('Прочитано');
    r.unmount();
    const d = open(row('delivered'));
    expect(texts(d)).toContain('Доставлено');
    d.unmount();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('пузырь различает отказ отдельной веткой — окно смотрит на то же поле', () => {
    const icon = SRC('screens', 'chat-components', 'MessageStatusIcon.tsx');
    expect(icon).toContain("case 'failed':");
    expect(icon).toContain('alert-circle-outline');
    expect(icon).toContain("case 'sending':");
  });

  it('состояние «не отправлено» ставит сама база, а не только экран', () => {
    const local = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'storage', 'local.ts'),
      'utf8',
    );
    expect(local).toContain("SET status = 'failed' WHERE status = 'sending'");
  });
});

describe('состояние называют своим словом', () => {
  it('отказ — «Не отправлено», и галочки при нём нет', () => {
    const t = open(row('failed'));
    const seen = texts(t);
    expect([seen.includes('Не отправлено'), seen.includes('Отправлено')]).toEqual([true, false]);
    expect(hasIcon(t, 'alert-circle-outline')).toBe(true);
    expect(hasIcon(t, 'checkmark-outline')).toBe(false);
    t.unmount();
  });

  it('пока отправляется — так и написано', () => {
    const t = open(row('sending'));
    expect(texts(t)).toContain('Отправляется…');
    t.unmount();
  });

  it('отправлено без CID — это ещё очередь', () => {
    const t = open(row('sent', null));
    expect(texts(t)).toContain('В очереди на отправку');
    t.unmount();
  });

  it('отправлено с CID — отправлено', () => {
    const t = open(row('sent', 'bafy886'));
    expect(texts(t)).toContain('Отправлено');
    t.unmount();
  });

  it('у неотправленного время создания не подписано отправкой', () => {
    const f = open(row('failed'));
    expect(texts(f)).toContain('Создано');
    f.unmount();
    const s = open(row('sent', 'bafy886'));
    expect(texts(s)).not.toContain('Создано');
    s.unmount();
  });

  it('время доставки показывают только у дошедшего', () => {
    const f = open(row('failed'));
    const times = texts(f).filter((s) => /\d{2}:\d{2}/.test(s));
    expect(times.length).toBe(1);
    f.unmount();
  });
});
