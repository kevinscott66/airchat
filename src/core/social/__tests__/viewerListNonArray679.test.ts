/**
 * Испорченный, но разобравшийся список посмотревших выдавался за факт
 * «никто не смотрел» (v4.32.679).
 *
 * `stories.viewed_by` и `group_messages.seen_by` — JSON-массивы ключей.
 * `parseViewerList` различал три случая: столбца нет (пустой список — факт),
 * столбец не открылся ключом (неизвестность), столбец не разобрался как JSON
 * (тоже неизвестность). Четвёртый случай — строка разобралась, но массивом не
 * оказалась — попадал в первую ветку: `{ viewers: [], unknown: false }`.
 *
 * Формы `{}` в этом столбце оговорка v4.32.189 в `local.ts` не выдумывает: она
 * прямо описывает недописанную запись, оставившую там `{}`. Писатель кладёт
 * сюда единственную форму — `JSON.stringify` массива строк, — поэтому любой
 * не-массив есть порча, и отличается он от порванного JSON только тем, что
 * успел разобраться. Ответы же были противоположные: `'{'` честно давал
 * неизвестность, `'{}'` — уверенное «никто».
 *
 * Цена неправды видна на обоих экранах. Своя сторис показывала «0 просмотров»
 * вместо значка «сказать нечем»; своё сообщение в группе — «Никто ещё не
 * прочитал» вместо перечёркнутого глаза, потому что `listGroupMessages` ставит
 * `seenUnreadable` ровно по `unknown`.
 */
import fs from 'fs';
import path from 'path';

import { mayCountViewers, parseViewerList, storyRingUnread, viewerCount } from '../viewerList';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const LOCAL = (): string => read('core/storage/local.ts');
const ROW = (): string => read('ui/components/StoriesRow.tsx');

/** Тело одной функции: утверждение не должно ловить совпадение из соседней. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  const body = src.slice(a, b);
  expect(body.length).toBeGreaterThan(100);
  return body;
}

describe('повод для правки жив', () => {
  it('порванный JSON всё это время отвечал неизвестностью — теперь ответы сошлись', () => {
    expect(parseViewerList('{')).toEqual({ viewers: [], unknown: true });
    expect(parseViewerList('не json вовсе')).toEqual({ viewers: [], unknown: true });
  });

  it('оговорка про недописанную запись с `{}` в столбце никуда не делась', () => {
    expect(LOCAL()).toContain('If a prior partial write stored `{}`');
  });

  it('признак для интерфейса групп по-прежнему берётся прямо из unknown', () => {
    expect(LOCAL()).toContain('seenUnreadable: !seenList.unknown ? undefined : true');
  });

  it('счётчик просмотров у своей сторис по-прежнему спрашивает правило', () => {
    const src = ROW();
    expect(src).toContain('mayCountViewers(viewerList)');
    expect(src).toContain('storyRingUnread(');
    expect(src.length).toBeGreaterThan(20_000);
  });

  it('оба пути записи берут только список, поэтому починка столбца не сломана', () => {
    const src = LOCAL();
    expect(slice(src, 'async function recordGroupSeenInTx(', '\nexport ')).toContain(
      'parseViewerList(cellTextOrNull(seenCell)).viewers'
    );
    expect(slice(src, 'async function recordStoryViewInTx(', '\n}')).toContain(
      'parseViewerList(cellTextOrNull(viewedCell)).viewers'
    );
  });
});

describe('не-массив в столбце', () => {
  it('объект, число, строка и null — все неизвестность', () => {
    for (const raw of ['{}', '{"a":1}', '42', '"a"', 'null', 'true']) {
      expect(parseViewerList(raw)).toEqual({ viewers: [], unknown: true });
    }
  });

  it('число просмотров не показывается', () => {
    const list = parseViewerList('{}');
    expect(mayCountViewers(list)).toBe(false);
    expect(viewerCount(list)).toBe(0);
  });

  it('кружок «новая сторис» не зажигается тем, что нечем погасить', () => {
    expect(storyRingUnread(parseViewerList('{}'), 'ключ-мой')).toBe(false);
  });

  it('список всё равно массив, и запись поверх допишет себя, а не упадёт', () => {
    const list = parseViewerList('{"a":1}');
    expect(Array.isArray(list.viewers)).toBe(true);
    expect([...list.viewers, 'ключ-мой']).toEqual(['ключ-мой']);
  });
});

describe('проверка не пустая', () => {
  it('пустой массив остаётся фактом «никто не смотрел»', () => {
    const list = parseViewerList('[]');
    expect(list).toEqual({ viewers: [], unknown: false });
    expect(mayCountViewers(list)).toBe(true);
  });

  it('целый список считается и гасит кружок только своему хозяину', () => {
    const list = parseViewerList('["ключ-а","ключ-б"]');
    expect(list).toEqual({ viewers: ['ключ-а', 'ключ-б'], unknown: false });
    expect(viewerCount(list)).toBe(2);
    expect(storyRingUnread(list, 'ключ-а')).toBe(false);
    expect(storyRingUnread(list, 'ключ-в')).toBe(true);
  });

  it('отсутствующий столбец по-прежнему не выдаётся за порчу', () => {
    expect(parseViewerList(null)).toEqual({ viewers: [], unknown: false });
    expect(parseViewerList('')).toEqual({ viewers: [], unknown: false });
  });

  it('непрочитанный столбец сильнее любой формы строки', () => {
    expect(parseViewerList('["ключ-а"]', true)).toEqual({ viewers: [], unknown: true });
    expect(parseViewerList('{}', true)).toEqual({ viewers: [], unknown: true });
  });
});
