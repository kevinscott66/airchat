/**
 * Выбор часа. Проверяется ровно то, где это можно сломать незаметно: переход
 * через полночь. Час 0 на «раньше» обязан дать 23, а не -1, и 23 на «позже» —
 * 0, а не 24; ни то ни другое не бросает исключения, просто в расписании
 * ночного режима появляется час, которого не бывает.
 *
 * Заодно тест держит имена стрелок: до выноса у них не было ни роли, ни
 * подписи, и озвучка на них молчала. Поиск здесь идёт по роли и имени —
 * пропадут они, и тест не найдёт кнопку.
 */
import React from 'react';

import { HourStepper } from '../settings/HourStepper';
import { makeStyles } from '../settings/settingsStyles';
import { lightColors } from '../../theme';
import { getByRole, press, render, unmount } from '../../__tests__/support/renderA11y';

const styles = makeStyles(lightColors, (n) => n);

function mount(hour: number, onChange: (h: number) => void) {
  return render(
    <HourStepper
      styles={styles}
      colors={lightColors}
      hour={hour}
      onChange={onChange}
      a11yName="начало тихих часов"
    />,
  );
}

describe('HourStepper', () => {
  it('полночь назад — это 23, а не минус первый час', async () => {
    const onChange = jest.fn();
    const r = await mount(0, onChange);
    await press(getByRole(r.root, 'button', { name: 'Часом раньше: начало тихих часов' }));
    expect(onChange).toHaveBeenCalledWith(23);
    await unmount(r);
  });

  it('23 вперёд — это 0, а не двадцать четвёртый час', async () => {
    const onChange = jest.fn();
    const r = await mount(23, onChange);
    await press(getByRole(r.root, 'button', { name: 'Часом позже: начало тихих часов' }));
    expect(onChange).toHaveBeenCalledWith(0);
    await unmount(r);
  });

  it('обычный шаг остаётся обычным шагом', async () => {
    const onChange = jest.fn();
    const r = await mount(9, onChange);
    await press(getByRole(r.root, 'button', { name: 'Часом позже: начало тихих часов' }));
    expect(onChange).toHaveBeenCalledWith(10);
    await unmount(r);
  });
});
