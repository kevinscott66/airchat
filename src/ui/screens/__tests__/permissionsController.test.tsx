/**
 * AC-14 / AC-15: экран «Разрешения» читает состояние без диалогов и никогда
 * не запускает два прохода запросов сразу.
 *
 * Экран рендерится с подменёнными разрешениями: у каждого `check` и `request`
 * — jest.fn, а ответ системного диалога — промис, который тест разрешает сам,
 * когда нужно. Так видно ровно то, что видит человек: сколько диалогов
 * всплыло, в каком порядке и что написано на карточке.
 */
import React from 'react';
import { AppState, Linking } from 'react-native';

import {
  act,
  getByRole,
  isDisabled,
  press,
  queryAllByRole,
  render,
  unmount,
  type Node,
} from '../../__tests__/support/renderA11y';
import type { PermissionDef, PermissionId } from '../permissionDefs';
import type { PermissionStatus } from '../permissionStatus';

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});

import { PermissionsScreen } from '../PermissionsScreen';

type Deferred = { promise: Promise<PermissionStatus>; resolve: (s: PermissionStatus) => void };
function deferred(): Deferred {
  let resolve!: (s: PermissionStatus) => void;
  const promise = new Promise<PermissionStatus>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Fake {
  def: PermissionDef;
  check: jest.Mock;
  request: jest.Mock;
  /** Открытые «системные диалоги» по порядку. */
  dialogs: Deferred[];
}

function fake(id: PermissionId, title: string, checked: PermissionStatus = 'unknown'): Fake {
  const dialogs: Deferred[] = [];
  const check = jest.fn(async () => checked);
  const request = jest.fn(() => {
    const d = deferred();
    dialogs.push(d);
    return d.promise;
  });
  return {
    def: { id, icon: '•', title, description: '', required: false, check, request },
    check,
    request,
    dialogs,
  };
}

let appStateListener: ((s: string) => void) | null = null;
beforeEach(() => {
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((ev: string, cb: (s: string) => void) => {
    if (ev === 'change') appStateListener = cb;
    return { remove: jest.fn(() => (appStateListener = null)) };
  }) as never);
  jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined as never);
});
afterEach(() => jest.restoreAllMocks());

function card(root: Node, title: string): Node {
  const [n] = queryAllByRole(root, 'button', { name: new RegExp(`^${title}: `) });
  if (!n) throw new Error(`нет карточки ${title}`);
  return n;
}
const cardLabel = (root: Node, title: string): string => card(root, title).props.accessibilityLabel as string;

describe('вход на экран: только чтение', () => {
  it('показывает выданное, частичное, отказанное и запрещённое без единого диалога', async () => {
    const f = [
      fake('notifications', 'Уведомления', 'granted'),
      fake('gallery', 'Галерея', 'limited'),
      fake('camera', 'Камера', 'denied'),
      fake('microphone', 'Микрофон', 'blocked'),
    ];
    const defs = f.map((x) => x.def);
    const r = await render(<PermissionsScreen onDone={jest.fn()} defs={defs} />);

    for (const x of f) {
      expect(x.check).toHaveBeenCalledTimes(1);
      expect(x.request).not.toHaveBeenCalled();
    }
    expect(cardLabel(r.root, 'Уведомления')).toBe('Уведомления: Разрешено ✓');
    expect(cardLabel(r.root, 'Галерея')).toBe('Галерея: Частично');
    expect(cardLabel(r.root, 'Камера')).toBe('Камера: Отказано');
    expect(cardLabel(r.root, 'Микрофон')).toBe('Микрофон: Запрещено');
    // Всё уже известно — «Разрешить всё» не предлагается, выход — «Готово».
    expect(queryAllByRole(r.root, 'button', { name: 'Разрешить всё' })).toHaveLength(0);
    expect(getByRole(r.root, 'button', { name: 'Готово' })).toBeTruthy();
    await unmount(r);
  });

  it('частичный доступ и запрет ведут в настройки системы, а не в повторный диалог', async () => {
    const gallery = fake('gallery', 'Галерея', 'limited');
    const r = await render(<PermissionsScreen onDone={jest.fn()} defs={[gallery.def]} />);
    await press(card(r.root, 'Галерея'));
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(gallery.request).not.toHaveBeenCalled();
    await unmount(r);
  });

  it('возвращение в приложение (AppState active) перечитывает состояние', async () => {
    const cam = fake('camera', 'Камера', 'blocked');
    const r = await render(<PermissionsScreen onDone={jest.fn()} defs={[cam.def]} />);
    expect(cardLabel(r.root, 'Камера')).toBe('Камера: Запрещено');

    // Человек ушёл в настройки системы и выдал камеру.
    cam.check.mockResolvedValue('granted');
    await act(() => appStateListener?.('background'));
    expect(cam.check).toHaveBeenCalledTimes(1);
    await act(() => appStateListener?.('active'));
    await act(async () => {});

    expect(cam.check).toHaveBeenCalledTimes(2);
    expect(cam.request).not.toHaveBeenCalled();
    expect(cardLabel(r.root, 'Камера')).toBe('Камера: Разрешено ✓');
    await unmount(r);
  });
});

describe('один проход запросов за раз', () => {
  it('двойное нажатие «Разрешить всё» — один цикл, диалоги строго по очереди', async () => {
    const a = fake('microphone', 'Микрофон');
    const b = fake('camera', 'Камера');
    const r = await render(<PermissionsScreen onDone={jest.fn()} defs={[a.def, b.def]} />);
    const all = getByRole(r.root, 'button', { name: 'Разрешить всё' });

    // Оба нажатия — до того, как React перерисует кнопку выключенной.
    let holder: Node | null = all;
    while (holder && typeof holder.props.onPress !== 'function') holder = holder.parent;
    const onPress = holder!.props.onPress as () => void;
    await act(() => {
      onPress();
      onPress();
    });
    expect(a.request).toHaveBeenCalledTimes(1);
    expect(b.request).not.toHaveBeenCalled();

    // Пока открыт диалог, кнопки выключены.
    expect(isDisabled(getByRole(r.root, 'button', { name: 'Разрешить всё' }))).toBe(true);
    expect(isDisabled(card(r.root, 'Камера'))).toBe(true);
    // И нажатие по карточке во время прохода второго цикла не начинает.
    await press(card(r.root, 'Камера'));
    expect(b.request).not.toHaveBeenCalled();

    await act(() => a.dialogs[0].resolve('granted'));
    expect(b.request).toHaveBeenCalledTimes(1);
    await act(() => b.dialogs[0].resolve('denied'));

    expect(a.request).toHaveBeenCalledTimes(1);
    expect(b.request).toHaveBeenCalledTimes(1);
    expect(cardLabel(r.root, 'Микрофон')).toBe('Микрофон: Разрешено ✓');
    expect(cardLabel(r.root, 'Камера')).toBe('Камера: Отказано');
    // Проход закончился — замок снят, повторное нажатие снова работает.
    expect(isDisabled(card(r.root, 'Камера'))).toBe(false);
    await press(card(r.root, 'Камера'));
    expect(b.request).toHaveBeenCalledTimes(2);
    await act(() => b.dialogs[1].resolve('granted'));
    await unmount(r);
  });

  it('«Пропустить» во время первого диалога: экран закрыт, следующих диалогов нет', async () => {
    const a = fake('microphone', 'Микрофон');
    const b = fake('camera', 'Камера');
    const c = fake('location', 'Геолокация');
    const onDone = jest.fn();
    const r = await render(<PermissionsScreen onDone={onDone} defs={[a.def, b.def, c.def]} />);

    await press(getByRole(r.root, 'button', { name: 'Разрешить всё' }));
    expect(a.request).toHaveBeenCalledTimes(1);

    const skip = getByRole(r.root, 'button', { name: 'Пропустить' });
    expect(isDisabled(skip)).toBe(false);
    await press(skip);
    expect(onDone).toHaveBeenCalledTimes(1);

    // Первый системный диалог закрылся уже после ухода.
    await act(() => a.dialogs[0].resolve('granted'));
    expect(b.request).not.toHaveBeenCalled();
    expect(c.request).not.toHaveBeenCalled();
    await unmount(r);
  });

  it('размонтирование посреди прохода тоже обрывает очередь', async () => {
    const a = fake('microphone', 'Микрофон');
    const b = fake('camera', 'Камера');
    const r = await render(<PermissionsScreen onDone={jest.fn()} defs={[a.def, b.def]} />);
    await press(getByRole(r.root, 'button', { name: 'Разрешить всё' }));
    await unmount(r);
    await act(() => a.dialogs[0].resolve('granted'));
    expect(b.request).not.toHaveBeenCalled();
  });

  it('возвращение в приложение посреди прохода не затирает ответ диалога', async () => {
    const a = fake('microphone', 'Микрофон');
    const r = await render(<PermissionsScreen onDone={jest.fn()} defs={[a.def]} />);
    await press(getByRole(r.root, 'button', { name: 'Разрешить всё' }));
    // На части устройств системный диалог сам даёт inactive → active.
    await act(() => appStateListener?.('active'));
    expect(a.check).toHaveBeenCalledTimes(1);
    a.check.mockResolvedValue('granted');
    await act(() => a.dialogs[0].resolve('granted'));
    await act(async () => {});
    // Отложенное чтение выполнено после прохода и согласуется с ответом.
    expect(a.check).toHaveBeenCalledTimes(2);
    expect(cardLabel(r.root, 'Микрофон')).toBe('Микрофон: Разрешено ✓');
    await unmount(r);
  });
});
