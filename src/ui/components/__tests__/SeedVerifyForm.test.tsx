/**
 * AC-21: форма проверки записи слов — так, как её видят в «Настройках»
 * (без «Сделаю позже») и при заведении аккаунта.
 */
import React from 'react';

import {
  changeText,
  getByRole,
  isDisabled,
  press,
  queryAllByRole,
  queryByTestId,
  render,
  unmount,
  visibleLabelOf,
  type Node,
} from '../../__tests__/support/renderA11y';
import { SEED_VERIFY_MISMATCH_TEXT, SeedVerifyForm } from '../SeedVerifyForm';

const WORDS = Array.from({ length: 24 }, (_, i) => `w${i + 1}`);

function answerFor(root: Node, i: number): { field: Node; word: string } {
  const field = queryByTestId(root, `seed_verify_input_${i}`)!;
  const m = (visibleLabelOf(root, field) ?? '').match(/№(\d+)$/);
  return { field, word: WORDS[Number(m![1]) - 1] };
}

describe('SeedVerifyForm', () => {
  it('без onDefer кнопки «Сделаю позже» нет', async () => {
    const r = await render(<SeedVerifyForm words={WORDS} onVerified={jest.fn()} onBack={jest.fn()} />);
    expect(queryAllByRole(r.root, 'button', { name: 'Сделаю позже' })).toHaveLength(0);
    expect(getByRole(r.root, 'button', { name: 'Назад к словам' })).toBeTruthy();
    await unmount(r);
  });

  it('неверный ответ: сообщение, onMismatch, onVerified не зовётся; правка ответа убирает сообщение', async () => {
    const onVerified = jest.fn();
    const onMismatch = jest.fn();
    const r = await render(
      <SeedVerifyForm words={WORDS} onVerified={onVerified} onMismatch={onMismatch} onBack={jest.fn()} />
    );
    for (let i = 0; i < 3; i++) await changeText(answerFor(r.root, i).field, 'nope');
    await press(getByRole(r.root, 'button', { name: 'Проверить' }));
    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
    expect(queryByTestId(r.root, 'seed_verify_error')).not.toBeNull();

    await changeText(answerFor(r.root, 0).field, 'x');
    expect(queryByTestId(r.root, 'seed_verify_error')).toBeNull();
    // Сообщение об ошибке не подсказывает само слово.
    expect(SEED_VERIFY_MISMATCH_TEXT).not.toMatch(/w\d/);
    await unmount(r);
  });

  it('кнопка выключена, пока есть пустое поле, и при busy', async () => {
    const r = await render(<SeedVerifyForm words={WORDS} onVerified={jest.fn()} onBack={jest.fn()} />);
    const btn = (): Node => getByRole(r.root, 'button', { name: 'Проверить' });
    expect(isDisabled(btn())).toBe(true);
    for (let i = 0; i < 2; i++) {
      const a = answerFor(r.root, i);
      await changeText(a.field, a.word);
    }
    expect(isDisabled(btn())).toBe(true);
    const last = answerFor(r.root, 2);
    await changeText(last.field, '   ');
    expect(isDisabled(btn())).toBe(true);
    await changeText(last.field, last.word);
    expect(isDisabled(btn())).toBe(false);
    await unmount(r);

    const busy = await render(<SeedVerifyForm words={WORDS} busy onVerified={jest.fn()} onBack={jest.fn()} />);
    expect(isDisabled(getByRole(busy.root, 'button', { name: 'Проверить' }))).toBe(true);
    await unmount(busy);
  });

  it('верные ответы зовут onVerified; «Назад к словам» — onBack', async () => {
    const onVerified = jest.fn();
    const onBack = jest.fn();
    const r = await render(<SeedVerifyForm words={WORDS} onVerified={onVerified} onBack={onBack} />);
    for (let i = 0; i < 3; i++) {
      const a = answerFor(r.root, i);
      await changeText(a.field, a.word);
    }
    await press(getByRole(r.root, 'button', { name: 'Проверить' }));
    expect(onVerified).toHaveBeenCalledTimes(1);
    await press(getByRole(r.root, 'button', { name: 'Назад к словам' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await unmount(r);
  });
});
