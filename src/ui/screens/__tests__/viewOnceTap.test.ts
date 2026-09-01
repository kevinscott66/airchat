/**
 * Нажатие на одноразовый снимок — один порядок на оба экрана (v4.32.516).
 *
 * Порядок был написан дважды: в личной переписке и в группе. Обе копии
 * разошлись, и каждая по-своему теряла ровно то, ради чего одноразовый снимок
 * существует.
 *
 * В ГРУППЕ не было ни одной проверки «экран ещё жив» (`grep -c isMountedRef
 * GroupsScreen.tsx` отвечал 0). Расшифровка вложения занимает время; уход из
 * группы в эти секунды заканчивался тем, что просмотрщик открывался в пустоту,
 * а через 0,8 секунды снимок удалялся у себя — снимок, которого никто так и не
 * увидел. Это тот же класс потери, который v4.32.359 закрыл для случая
 * `missing > 0`.
 *
 * В ЛИЧНОЙ ПЕРЕПИСКЕ — обратная беда: отложенное удаление ОТМЕНЯЛОСЬ уходом с
 * экрана (`if (!isMountedRef.current) return` внутри таймера). Снимок к этому
 * мгновению уже показан, так что «одноразовое» фото оставалось в переписке
 * навсегда у всякого, кто успевал выйти за 0,8 секунды.
 *
 * И общее для обеих: у удаления не было catch. Сорвалось — необработанное
 * отклонение обещания, а «одноразовый» снимок молча остаётся читаемым, и не
 * сказано об этом никому.
 */
import fs from 'fs';
import path from 'path';

import { VIEW_ONCE_DELETE_DELAY_MS, runViewOnceTap, type ViewOnceTapDeps } from '../chat-utils/viewOnceTap';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const CHAT = read('ui', 'screens', 'ChatScreen.tsx');
const GROUPS = read('ui', 'screens', 'GroupsScreen.tsx');
const MODULE = read('ui', 'screens', 'chat-utils', 'viewOnceTap.ts');

/** Стенд: зависимости — счётчики, отложенное держим в руках. */
function stand(over: Partial<ViewOnceTapDeps> = {}) {
  const pending: Array<() => void> = [];
  let living = true;
  const deps: ViewOnceTapDeps = {
    resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 0 })),
    alive: jest.fn(() => living),
    open: jest.fn(),
    later: jest.fn((fn: () => void) => { pending.push(fn); }),
    remove: jest.fn(async () => {}),
    reload: jest.fn(),
    onUnavailable: jest.fn(),
    onRemoveFailed: jest.fn(),
    ...over,
  };
  return {
    deps,
    /** Уйти с экрана. */
    leave: () => { living = false; },
    /** Дать отложенному сроку истечь. */
    async elapse() {
      const queue = pending.splice(0, pending.length);
      queue.forEach((fn) => fn());
      // Удаление и перечитывание живут в цепочке обещаний внутри таймера.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('показали — удаляем; не показали — не трогаем', () => {
  it('удачное нажатие: открыли, потом отложенно удалили и перечитали список', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    expect(s.deps.open).toHaveBeenCalledWith(['file:///a.jpg']);
    expect(s.deps.remove).not.toHaveBeenCalled();
    await s.elapse();
    expect(s.deps.remove).toHaveBeenCalledTimes(1);
    expect(s.deps.reload).toHaveBeenCalledTimes(1);
    expect(s.deps.onRemoveFailed).not.toHaveBeenCalled();
  });

  it('ушли с экрана, пока вложение расшифровывалось, — не показываем и НЕ УДАЛЯЕМ', async () => {
    // Ровно то, чего в группе не было ни в каком виде: снимок уничтожался
    // непоказанным.
    const s = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 0 })) });
    const run = runViewOnceTap(s.deps);
    s.leave();
    await run;
    expect(s.deps.open).not.toHaveBeenCalled();
    expect(s.deps.later).not.toHaveBeenCalled();
    expect(s.deps.remove).not.toHaveBeenCalled();
    // И молчим: показывать «снимок недоступен» уже некому.
    expect(s.deps.onUnavailable).not.toHaveBeenCalled();
  });

  it('нечего показывать — говорим об этом, а не молчим', async () => {
    const s = stand({ resolve: jest.fn(async () => ({ uris: [], missing: 2 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.onUnavailable).toHaveBeenCalledTimes(1);
    expect(s.deps.open).not.toHaveBeenCalled();
    expect(s.deps.remove).not.toHaveBeenCalled();
  });

  it('показали не всё — не удаляем ничего (v4.32.359)', async () => {
    // Строка в базе держит единственную ссылку на нерасшифрованные снимки.
    const s = stand({ resolve: jest.fn(async () => ({ uris: ['file:///a.jpg'], missing: 1 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.open).toHaveBeenCalledWith(['file:///a.jpg']);
    expect(s.deps.later).not.toHaveBeenCalled();
    expect(s.deps.remove).not.toHaveBeenCalled();
  });

  it('пустой список важнее, чем missing: даже если расшифровать не удалось ничего', async () => {
    const s = stand({ resolve: jest.fn(async () => ({ uris: [], missing: 0 })) });
    await runViewOnceTap(s.deps);
    expect(s.deps.onUnavailable).toHaveBeenCalledTimes(1);
  });
});

describe('уход с экрана после показа удаление НЕ отменяет', () => {
  it('снимок показан — значит будет удалён, даже если из чата уже вышли', async () => {
    // Изъян личной переписки: проверка «экран жив» стояла ВНУТРИ таймера, и
    // выход за 0,8 секунды оставлял «одноразовое» фото навсегда.
    const s = stand();
    await runViewOnceTap(s.deps);
    s.leave();
    await s.elapse();
    expect(s.deps.remove).toHaveBeenCalledTimes(1);
  });

  it('а вот перечитывать список ушедшему экрану уже нельзя', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    s.leave();
    await s.elapse();
    expect(s.deps.reload).not.toHaveBeenCalled();
  });

  it('остались в чате — список перечитывается', async () => {
    const s = stand();
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.reload).toHaveBeenCalledTimes(1);
  });
});

describe('сорвавшееся удаление договаривается словами', () => {
  it('отказ базы — текст пользователю, а не необработанное отклонение обещания', async () => {
    const s = stand({ remove: jest.fn(async () => { throw new Error('disk'); }) });
    await runViewOnceTap(s.deps);
    await s.elapse();
    expect(s.deps.onRemoveFailed).toHaveBeenCalledTimes(1);
    expect(s.deps.reload).not.toHaveBeenCalled();
  });

  it('отказ не роняет само нажатие', async () => {
    const s = stand({ remove: jest.fn(async () => { throw new Error('disk'); }) });
    await expect(runViewOnceTap(s.deps)).resolves.toBeUndefined();
    await expect(s.elapse()).resolves.toBeUndefined();
  });

  it('срыв расшифровки поднимается наверх — там его ловит void, а не тишина', async () => {
    const s = stand({ resolve: jest.fn(async () => { throw new Error('net'); }) });
    await expect(runViewOnceTap(s.deps)).rejects.toThrow('net');
    expect(s.deps.open).not.toHaveBeenCalled();
    expect(s.deps.remove).not.toHaveBeenCalled();
  });

  it('задержка одна на оба экрана и та же, что была выписана числом', () => {
    expect(VIEW_ONCE_DELETE_DELAY_MS).toBe(800);
  });
});

describe('BEFORE — что делали разошедшиеся копии', () => {
  /** Группа: ни одной проверки «экран жив». */
  const asGroupBefore = (alive: boolean) => {
    const done: string[] = [];
    done.push('open');
    done.push('remove');
    if (alive) done.push('reload');
    return done;
  };

  /** Личная переписка: проверка стояла внутри таймера — и отменяла удаление. */
  const asChatBefore = (aliveAtTimer: boolean) => (aliveAtTimer ? ['remove', 'reload'] : []);

  it('группа удаляла снимок, которого никто не видел', () => {
    expect(asGroupBefore(false)).toContain('remove');
    // Новый порядок в том же положении не делает НИЧЕГО.
    expect(asGroupBefore(false)).toContain('open');
  });

  it('личная переписка оставляла показанный снимок навсегда', () => {
    expect(asChatBefore(false)).toEqual([]);
  });

  it('обе беды — про один и тот же вопрос, заданный не в том месте', () => {
    // Один раз «жив ли экран» спросили слишком поздно, другой — слишком рано;
    // теперь он задан ровно дважды и в обоих нужных точках.
    expect(MODULE.split('deps.alive()').length - 1).toBe(2);
  });
});

/** Рэтчет формы: копия порядка ровно одна. */
describe('форма исходников', () => {
  it('оба экрана зовут общий порядок', () => {
    expect(CHAT).toContain('void runViewOnceTap({');
    expect(GROUPS).toContain('void runViewOnceTap({');
  });

  it('в группе появился флаг «экран жив» и снимается при уходе', () => {
    expect(GROUPS).toContain('const isMountedRef = useRef(true);');
    expect(GROUPS).toContain('isMountedRef.current = false;');
    expect(GROUPS).toContain('alive: () => isMountedRef.current,');
  });

  it('задержка нигде не выписана числом заново', () => {
    const grpHandler = GROUPS.slice(GROUPS.indexOf('const handleGrpViewOnceTap'));
    const chatHandler = CHAT.slice(CHAT.indexOf('const handleViewOnceTap'));
    for (const body of [grpHandler.slice(0, grpHandler.indexOf('const reloadStarred')),
      chatHandler.slice(0, chatHandler.indexOf('const toggleSelect'))]) {
      expect(body).toContain('VIEW_ONCE_DELETE_DELAY_MS');
      expect(body).not.toContain(', 800)');
    }
  });

  it('в личной переписке нет прежней отмены удаления внутри таймера', () => {
    expect(CHAT).not.toContain('if (svc) void svc.deleteMessageLocally(row.id).then(() => {');
  });

  it('оба экрана говорят про сорвавшееся удаление одними словами', () => {
    for (const screen of [CHAT, GROUPS]) {
      expect(screen).toContain("onRemoveFailed: () => showError('Не удалось удалить одноразовый снимок')");
      expect(screen).toContain("onUnavailable: () => showError('Снимок больше недоступен')");
    }
  });

  it('порядок проверяется без просмотрщика, базы и рендеринга', () => {
    expect(MODULE.split('\n').filter((l) => l.startsWith('import '))).toEqual([]);
  });
});
