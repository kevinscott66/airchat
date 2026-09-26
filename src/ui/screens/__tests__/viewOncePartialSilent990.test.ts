/**
 * v4.32.990: неполно открывшийся одноразовый снимок перестал молчать.
 *
 * Дефект. `runViewOnceTap` на `missing > 0` открывает просмотрщик с тем, что
 * расшифровалось, и ничего не говорит. Уцелевшие снимки в нём неотличимы от
 * всего сообщения: счётчика «2 из 3» у просмотрщика нет, подписи с числами
 * есть только у публикаций (`mediaSlotsNotice`, v4.32.852).
 *
 * Цена. Ветка эта нарочно ничего не удаляет (v4.32.359): строка в базе держит
 * единственную ссылку на нерасшифрованные снимки, и нажать можно ещё раз. Но
 * человек не знает, что есть на что нажимать, — он уверен, что видел всё. А
 * вложение живёт на relay около трёх часов: «попробую потом» здесь значит
 * «никогда». Одноразовый снимок при этом второй раз не покажут по замыслу,
 * так что и переспросить отправителя — не выход.
 *
 * Правка. Числа называются вслух той же меркой, что у публикаций: сколько
 * открылось из скольких, — и сказано, что сообщение осталось.
 *
 * Границы. Когда не открылось НИЧЕГО, речь прежняя («снимок больше
 * недоступен»): просмотрщик не открывается, и звать нажимать ещё раз не на
 * что. Полный показ по-прежнему молчит.
 */
import fs from 'fs';
import path from 'path';

import {
  runViewOnceTap,
  viewOncePartialText,
  type ViewOnceTapDeps,
} from '../chat-utils/viewOnceTap';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Стенд: зависимости — счётчики; отложенное здесь не нужно. */
function stand(over: Partial<ViewOnceTapDeps> = {}) {
  const deps: ViewOnceTapDeps = {
    resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 0 })),
    alive: jest.fn(() => true),
    open: jest.fn(),
    later: jest.fn(),
    remove: jest.fn(async () => true),
    note: jest.fn(async () => true),
    forget: jest.fn(async () => undefined),
    reload: jest.fn(),
    onUnavailable: jest.fn(),
    onPartial: jest.fn(),
    onRemoveFailed: jest.fn(),
    ...over,
  };
  return deps;
}

describe('открылось не всё — об этом говорят', () => {
  it('из трёх снимков открылся один — названы оба числа', async () => {
    const deps = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 2 })) });
    await runViewOnceTap(deps);
    expect(deps.onPartial).toHaveBeenCalledWith(1, 3);
  });

  it('сказано ДО показа: за открытым просмотрщиком плашку не видно', async () => {
    const order: string[] = [];
    const deps = stand({
      resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 1 })),
      onPartial: jest.fn(() => { order.push('said'); }),
      open: jest.fn(() => { order.push('opened'); }),
    });
    await runViewOnceTap(deps);
    expect(order).toEqual(['said', 'opened']);
  });

  it('ушли с экрана во время расшифровки — молчим, как и не показываем', async () => {
    let living = true;
    const deps = stand({
      resolve: jest.fn(async () => { living = false; return { uris: ['file:///a.jpg'], missing: 1 }; }),
      alive: jest.fn(() => living),
    });
    await runViewOnceTap(deps);
    expect(deps.onPartial).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('подпись называет числа и зовёт нажать ещё раз', () => {
    const said = viewOncePartialText(1, 3);
    expect(said).toContain('1 из 3');
    expect(said).toContain('сообщение осталось');
    expect(said).toContain('попробуйте ещё раз');
  });

  it('оба экрана говорят это одними словами', () => {
    const line = 'onPartial: (shown, total) => showError(viewOncePartialText(shown, total)),';
    expect(read('ui', 'screens', 'ChatScreen.tsx')).toContain(line);
    expect(read('ui', 'screens', 'GroupsScreen.tsx')).toContain(line);
  });
});

describe('ГРАНИЦА: соседние исходы не тронуты', () => {
  it('не открылось ничего — прежняя речь, и просмотрщик не открывается', async () => {
    const deps = stand({ resolve: jest.fn(async () => ({ uris: [], missing: 2 })) });
    await runViewOnceTap(deps);
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
    expect(deps.onPartial).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('открылось всё — молчим', async () => {
    const deps = stand();
    await runViewOnceTap(deps);
    expect(deps.onPartial).not.toHaveBeenCalled();
    expect(deps.open).toHaveBeenCalledTimes(1);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: правило неполного показа то же, что было', () => {
  it('ничего не удаляется и не откладывается (v4.32.359)', async () => {
    const deps = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 1 })) });
    await runViewOnceTap(deps);
    expect(deps.open).toHaveBeenCalledWith(['file:///a.jpg'], { allowShare: false });
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.later).not.toHaveBeenCalled();
    expect(deps.note).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('ядро по-прежнему схлопывает неоткрывшиеся вложения в одно число', () => {
    const resolve = read('core', 'media', 'resolveMediaCids.ts');
    expect(resolve).toContain('const uris = slots.filter((u): u is string => u !== null);');
    expect(resolve).toContain('return { uris, missing: cids.length - uris.length };');
  });

  it('у просмотрщика своего счётчика нет: числа есть только у публикаций', () => {
    const slots = read('core', 'media', 'mediaSlots.ts');
    expect(slots).toContain('export function mediaSlotsNotice');
    // Ни один экран не зовёт подпись публикаций для одноразового снимка —
    // иначе её и надо было бы звать, а не заводить свою.
    for (const screen of ['ChatScreen.tsx', 'GroupsScreen.tsx']) {
      const src = read('ui', 'screens', screen);
      const at = src.indexOf('runViewOnceTap({');
      expect(at).toBeGreaterThan(0);
      expect(src.slice(at, at + 2000)).not.toContain('mediaSlotsNotice');
    }
  });
});
