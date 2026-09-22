/**
 * Рендер экрана и поиск по тому, что слышит озвучка, — без сторонней библиотеки.
 *
 * @testing-library/react-native в проекте не установлен, а react-test-renderer
 * приходит вместе с jest-expo. Здесь — ровно два запроса, которых не хватало:
 * «кнопка с таким именем» и «поле с такой подписью». Ищутся host-элементы (то,
 * что уходит в нативный слой или, на вебе, в DOM), а не компоненты: роль,
 * заданная в JSX, но потерянная по дороге к View, озвучке ничего не даёт.
 *
 * Файл лежит в `__tests__/support` и сам тестом не является (testMatch берёт
 * только `*.test.ts(x)`).
 */
import React from 'react';

/** Узел дерева react-test-renderer — нужная тестам часть его API. */
export type Node = {
  type: unknown;
  props: Record<string, unknown>;
  parent: Node | null;
  children: Array<Node | string>;
  findAll: (pred: (n: Node) => boolean, opts?: { deep?: boolean }) => Node[];
};

type Renderer = {
  root: Node;
  update: (el: React.ReactElement) => void;
  unmount: () => void;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const TR = require('react-test-renderer') as {
  create: (el: React.ReactElement) => Renderer;
  act: (cb: () => unknown) => Promise<void> | void;
};

// React 19 требует явно объявить среду act — иначе каждое обновление
// печатает предупреждение «not configured to support act».
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function render(el: React.ReactElement): Promise<Renderer> {
  let r: Renderer | null = null;
  await TR.act(async () => {
    r = TR.create(el);
  });
  await flush();
  return r as unknown as Renderer;
}

export async function unmount(r: Renderer): Promise<void> {
  await TR.act(async () => {
    r.unmount();
  });
}

/** Дать отработать отложенным промисам и эффектам. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await TR.act(async () => {
      await Promise.resolve();
    });
  }
}

export async function act(cb: () => unknown): Promise<void> {
  await TR.act(async () => {
    await cb();
  });
}

const isHost = (n: Node): boolean => typeof n.type === 'string';

/** Весь текст внутри узла, как его прочтёт озвучка при отсутствии подписи. */
export function textOf(n: Node | string): string {
  if (typeof n === 'string') return n;
  return n.children.map(textOf).join('');
}

function matches(value: unknown, name: string | RegExp): boolean {
  if (typeof value !== 'string') return false;
  return typeof name === 'string' ? value === name : name.test(value);
}

function roleOf(n: Node): unknown {
  return n.props.role ?? n.props.accessibilityRole;
}

function labelOf(n: Node): unknown {
  return n.props['aria-label'] ?? n.props.accessibilityLabel;
}

/** Все host-элементы с этой ролью и этим именем. */
export function queryAllByRole(root: Node, role: string, opts: { name: string | RegExp }): Node[] {
  return root.findAll((n) => isHost(n) && roleOf(n) === role && matches(labelOf(n), opts.name));
}

export function getByRole(root: Node, role: string, opts: { name: string | RegExp }): Node {
  const found = queryAllByRole(root, role, opts);
  if (found.length !== 1) {
    const roles = root
      .findAll((n) => isHost(n) && roleOf(n) != null)
      .map((n) => `${String(roleOf(n))}:${String(labelOf(n))}`);
    throw new Error(
      `getByRole(${role}, ${String(opts.name)}): найдено ${found.length}. На экране: ${roles.join(', ')}`
    );
  }
  return found[0];
}

/**
 * Поле с подписью: по собственному `accessibilityLabel` ИЛИ по видимому
 * тексту элемента, на который оно ссылается через `accessibilityLabelledBy`.
 */
export function getByLabelText(root: Node, label: string | RegExp): Node {
  const byNativeId = new Map<string, Node>();
  for (const n of root.findAll((x) => isHost(x) && typeof x.props.nativeID === 'string')) {
    byNativeId.set(n.props.nativeID as string, n);
  }
  const found = root.findAll((n) => {
    if (!isHost(n)) return false;
    if (matches(labelOf(n), label)) return true;
    const ref = n.props['aria-labelledby'] ?? n.props.accessibilityLabelledBy;
    const target = typeof ref === 'string' ? byNativeId.get(ref) : undefined;
    return target ? matches(textOf(target).trim(), label) : false;
  });
  if (found.length !== 1) {
    throw new Error(`getByLabelText(${String(label)}): найдено ${found.length}`);
  }
  return found[0];
}

/** Видимая подпись поля — текст элемента, на который указывает labelledBy. */
export function visibleLabelOf(root: Node, field: Node): string | null {
  const ref = field.props['aria-labelledby'] ?? field.props.accessibilityLabelledBy;
  if (typeof ref !== 'string') return null;
  const [target] = root.findAll((x) => isHost(x) && x.props.nativeID === ref);
  return target ? textOf(target).trim() : null;
}

export function isDisabled(n: Node): boolean {
  const st = n.props.accessibilityState as { disabled?: boolean } | undefined;
  return n.props['aria-disabled'] === true || st?.disabled === true;
}

/** Нажать: ближайший предок с `onPress` — ровно то, что вызвал бы жест. */
export async function press(n: Node): Promise<void> {
  let cur: Node | null = n;
  while (cur && typeof cur.props.onPress !== 'function') cur = cur.parent;
  if (!cur) throw new Error('press: у элемента нет onPress');
  if (isDisabled(n) || cur.props.disabled === true) return;
  const onPress = cur.props.onPress as (e?: unknown) => unknown;
  await act(() => onPress({ nativeEvent: {} }));
  await flush();
}

/** Набрать текст в поле. */
export async function changeText(n: Node, text: string): Promise<void> {
  const fn = n.props.onChangeText as ((t: string) => void) | undefined;
  if (!fn) throw new Error('changeText: у поля нет onChangeText');
  await act(() => fn(text));
}

export function queryByTestId(root: Node, id: string): Node | null {
  const [n] = root.findAll((x) => isHost(x) && x.props.testID === id);
  return n ?? null;
}
