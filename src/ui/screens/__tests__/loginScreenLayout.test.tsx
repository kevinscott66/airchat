/**
 * AC-16: экран имени стоит в той же колонке, что знакомство и сброс пароля,
 * а клавиатура не закрывает поле.
 *
 * Проверяется отрисованное дерево: у колонки (`login_screen`) итоговый стиль
 * «во всю ширину, но не шире formColumn, по центру»; колонка лежит в прокрутке,
 * которая не глотает нажатие по кнопке при открытой клавиатуре, а прокрутка —
 * в KeyboardAvoidingView. При показе клавиатуры содержимое перестаёт
 * центрироваться по вертикали и прижимается к верху — иначе поле и кнопка
 * уходят под IME.
 */
import React from 'react';
import { Keyboard, KeyboardAvoidingView, ScrollView, StyleSheet } from 'react-native';

import { act, queryByTestId, render, unmount, type Node } from '../../__tests__/support/renderA11y';
import { formColumn } from '../../theme';

jest.mock('../../components/SafeScreen', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeScreen: ({ children }: { children?: React.ReactNode }) => <View>{children}</View> };
});
jest.mock('../../components/LoadingOverlay', () => ({ LoadingOverlay: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../core/identity/profile', () => ({ buildSignedProfile: jest.fn() }));
jest.mock('../../../core/identity/profileManager', () => ({
  profileManager: { init: jest.fn(), getActiveProfile: jest.fn(() => null), renameProfile: jest.fn() },
}));

import { LoginScreen } from '../LoginScreen';

const PAIR = { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(64).fill(2) };

function ancestorOfType(n: Node, type: unknown): Node | null {
  let cur = n.parent;
  while (cur && cur.type !== type) cur = cur.parent;
  return cur;
}

describe('экран имени', () => {
  it('колонка той же ширины, что у знакомства: 100% и не шире formColumn, по центру', async () => {
    const r = await render(<LoginScreen pair={PAIR as never} onDone={jest.fn()} />);
    const column = queryByTestId(r.root, 'login_screen');
    expect(column).not.toBeNull();
    const style = StyleSheet.flatten(column!.props.style as never) as Record<string, unknown>;
    expect(style.width).toBe('100%');
    expect(style.maxWidth).toBe(formColumn.maxWidth);
    expect(style.alignSelf).toBe('center');
    await unmount(r);
  });

  it('поле лежит в прокрутке внутри KeyboardAvoidingView; кнопка нажимается при открытой клавиатуре', async () => {
    const r = await render(<LoginScreen pair={PAIR as never} onDone={jest.fn()} />);
    const input = queryByTestId(r.root, 'login_username_input')!;
    const scroll = ancestorOfType(input, ScrollView);
    expect(scroll).not.toBeNull();
    expect(scroll!.props.keyboardShouldPersistTaps).toBe('handled');
    expect(ancestorOfType(scroll!, KeyboardAvoidingView)).not.toBeNull();
    await unmount(r);
  });

  it('при показе клавиатуры содержимое прижимается к верху, после скрытия — снова по центру', async () => {
    const listeners: Record<string, () => void> = {};
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((ev: string, cb: () => void) => {
      listeners[ev] = cb;
      return { remove: jest.fn() };
    }) as never);
    const r = await render(<LoginScreen pair={PAIR as never} onDone={jest.fn()} />);
    const scrollStyle = (): Record<string, unknown> => {
      const input = queryByTestId(r.root, 'login_username_input')!;
      const scroll = ancestorOfType(input, ScrollView)!;
      return StyleSheet.flatten(scroll.props.contentContainerStyle as never) as Record<string, unknown>;
    };
    expect(scrollStyle().justifyContent).toBe('center');
    const showEv = Object.keys(listeners).find((k) => /Show$/.test(k))!;
    const hideEv = Object.keys(listeners).find((k) => /Hide$/.test(k))!;
    await act(() => listeners[showEv]());
    expect(scrollStyle().justifyContent).toBe('flex-start');
    await act(() => listeners[hideEv]());
    expect(scrollStyle().justifyContent).toBe('center');
    await unmount(r);
    spy.mockRestore();
  });
});
