/**
 * v4.32.877. Нажал на закреплённое сообщение — не произошло ничего.
 *
 * Дефект. Переход к сообщению (цитата в ответе, плашка закрепа, пункт списка
 * закреплённых, ссылка из поиска) искал строку только среди загруженных и при
 * промахе выходил молча: `if (idx < 0) return;`. Переписка же открывается
 * последней страницей — PAGE = 40 в личной, PAGE_SIZE = 60 в группе, — а
 * закреплённые читаются по всей истории. Закреп почти всегда старше окна,
 * поэтому нажатие на его плашку не работало практически всегда.
 *
 * Цена. Нажатие без ответа читается как сломанная кнопка: ни прокрутки, ни
 * подсветки, ни слова. Человек жмёт ещё раз и ещё, а экран молчит — и понять,
 * что сообщение просто не загружено, неоткуда.
 *
 * Правка. Не нашли — догружаем страницу тем же путём, которым её догружает
 * прокрутка, и ищем снова. Исходов ровно три, и все со словами: прокрутили,
 * «сообщение не найдено» (история кончилась) или «слишком далеко» (упёрлись в
 * потолок попыток). Решение вынесено в chat-utils/jumpToMessage — оно одно на
 * оба экрана, и проверить его можно без отрисовки.
 */
import fs from 'fs';
import path from 'path';

import {
  JUMP_MAX_STEPS,
  JUMP_MISSING_TEXT,
  JUMP_TOO_FAR_TEXT,
  jumpFailureText,
  nextJumpStep,
  runJump,
  type JumpDriver,
} from '../jumpToMessage';

const SCREENS = path.join(__dirname, '..', '..');
const read = (name: string): string => fs.readFileSync(path.join(SCREENS, name), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CHAT = (): string => codeOnly(read('ChatScreen.tsx'));
const GROUPS = (): string => codeOnly(read('GroupsScreen.tsx'));

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('переход к сообщению по-прежнему живёт на обоих экранах и зовётся из ленты', () => {
    for (const [name, src] of Object.entries({ 'переписка': CHAT(), 'группа': GROUPS() })) {
      expect([name, src.includes('const scrollToReply = useCallback((replyToId: string) => {')])
        .toEqual([name, true]);
    }
    // Нажатие на цитату: в переписке оно приходит строкой, в группе — самой
    // лентой, поэтому места разные, а переход один.
    expect(CHAT()).toContain('onReplyTap={scrollToReply}');
    expect(GROUPS()).toContain('onPress={() => item.replyToId && scrollToReply(item.replyToId)}');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('окно и правда куцее: обе переписки открываются одной страницей', () => {
    expect(codeOnly(fs.readFileSync(path.join(SCREENS, 'chat-utils', 'constants.ts'), 'utf8')))
      .toContain('export const PAGE = 40;');
    expect(GROUPS()).toContain('const PAGE_SIZE = 60;');
    // И догрузка остальных страниц у каждого экрана своя — потому решение и
    // вынесено отдельно от них обоих.
    expect(CHAT()).toContain('const loadOlder = useCallback(async () => {');
    expect(GROUPS()).toContain('const loadMore = useCallback(async () => {');
  });

  it('закреплённое читается по всей истории, а не по загруженному окну', () => {
    expect(CHAT()).toContain('resolveDmPinned(peerB64, activeProfileId)');
    // Плашка закрепа и список закреплённых ведут в тот же переход.
    expect(CHAT()).toContain('scrollToReply(displayPin.id);');
    expect(GROUPS()).toContain('const handlePinnedJumpTo = useCallback((id: string, idx: number) => {');
  });
});

describe('решение о следующем шаге', () => {
  it('нашли — прокручиваем, ничего не догружая', () => {
    expect(nextJumpStep(true, true, 0)).toBe('scroll');
    expect(nextJumpStep(true, false, JUMP_MAX_STEPS + 5)).toBe('scroll');
  });

  it('не нашли, а история кончилась — такого сообщения нет', () => {
    expect(nextJumpStep(false, false, 0)).toBe('missing');
  });

  it('не нашли, но есть что догрузить — догружаем', () => {
    expect(nextJumpStep(false, true, 0)).toBe('load');
    expect(nextJumpStep(false, true, JUMP_MAX_STEPS - 1)).toBe('load');
  });

  it('потолок попыток — это «далеко», а не «нет»', () => {
    expect(nextJumpStep(false, true, JUMP_MAX_STEPS)).toBe('too-far');
    expect(jumpFailureText('too-far')).toBe(JUMP_TOO_FAR_TEXT);
    expect(jumpFailureText('missing')).toBe(JUMP_MISSING_TEXT);
    // Оба текста написаны для человека: без «страниц», «курсоров» и «id».
    for (const t of [JUMP_MISSING_TEXT, JUMP_TOO_FAR_TEXT]) {
      expect(t).not.toMatch(/страниц|курсор|\bid\b|index|CID/i);
      expect(t.length).toBeGreaterThan(20);
    }
  });
});

type Log = { loads: number; scrolled: boolean; failed: string | null };

function driver(opts: {
  foundAfter: number | null;
  pages: number;
  maxSteps?: number;
  alive?: () => boolean;
}): { d: JumpDriver; log: Log } {
  const log: Log = { loads: 0, scrolled: false, failed: null };
  const d: JumpDriver = {
    found: () => opts.foundAfter !== null && log.loads >= opts.foundAfter,
    hasMore: () => log.loads < opts.pages,
    loadOlder: async () => { log.loads += 1; },
    settle: async () => { /* в тесте список «раскладывается» сразу */ },
    scroll: () => { log.scrolled = true; },
    fail: (text) => { log.failed = text; },
    alive: opts.alive,
    maxSteps: opts.maxSteps,
  };
  return { d, log };
}

describe('переход доводится до конца', () => {
  it('сообщение в загруженном окне — прокрутка без единой догрузки', async () => {
    const { d, log } = driver({ foundAfter: 0, pages: 10 });
    await expect(runJump(d)).resolves.toBe('scroll');
    expect(log).toEqual({ loads: 0, scrolled: true, failed: null });
  });

  it('сообщение страницами ниже — догружаем и прокручиваем', async () => {
    const { d, log } = driver({ foundAfter: 3, pages: 10 });
    await expect(runJump(d)).resolves.toBe('scroll');
    expect(log.loads).toBe(3);
    expect(log.scrolled).toBe(true);
    expect(log.failed).toBeNull();
  });

  it('история кончилась — говорим «не найдено», а не молчим', async () => {
    const { d, log } = driver({ foundAfter: null, pages: 2 });
    await expect(runJump(d)).resolves.toBe('missing');
    expect(log.loads).toBe(2);
    expect(log.scrolled).toBe(false);
    expect(log.failed).toBe(JUMP_MISSING_TEXT);
  });

  it('истории больше, чем готовы пройти — говорим «слишком далеко»', async () => {
    const { d, log } = driver({ foundAfter: null, pages: 1000, maxSteps: 4 });
    await expect(runJump(d)).resolves.toBe('too-far');
    expect(log.loads).toBe(4);
    expect(log.failed).toBe(JUMP_TOO_FAR_TEXT);
  });

  it('экран закрыли — догрузка прекращается и ничего не всплывает', async () => {
    let alive = true;
    const { d, log } = driver({
      foundAfter: null,
      pages: 1000,
      alive: () => alive,
    });
    const orig = d.loadOlder;
    d.loadOlder = async () => { await orig(); if (log.loads === 2) alive = false; };
    await runJump(d);
    expect(log.loads).toBe(2);
    expect(log.scrolled).toBe(false);
    expect(log.failed).toBeNull();
  });

  it('потолок по умолчанию не бесконечный и не однократный', () => {
    expect(JUMP_MAX_STEPS).toBeGreaterThanOrEqual(5);
    expect(JUMP_MAX_STEPS).toBeLessThanOrEqual(50);
  });
});

describe('оба экрана ходят этим путём', () => {
  it('переписка и группа зовут общий разбор вместо немого выхода', () => {
    for (const [name, src] of Object.entries({ 'переписка': CHAT(), 'группа': GROUPS() })) {
      expect([name, src.includes("from './chat-utils/jumpToMessage'")]).toEqual([name, true]);
      expect([name, src.includes('void runJump({')]).toEqual([name, true]);
      expect([name, src.includes('fail: (text) => showError(text),')]).toEqual([name, true]);
      expect([name, src.includes('alive: () => isMountedRef.current,')]).toEqual([name, true]);
    }
  });

  it('прежнего немого выхода из перехода не осталось ни там, ни там', () => {
    for (const [name, src] of Object.entries({ 'переписка': CHAT(), 'группа': GROUPS() })) {
      const at = src.indexOf('const scrollToReply = useCallback((replyToId: string) => {');
      expect([name, at]).not.toEqual([name, -1]);
      const body = src.slice(at, src.indexOf('\n  }, [', at));
      expect([name, body.includes('if (idx < 0) return;')]).toEqual([name, false]);
      expect([name, body.includes('runJump(')]).toEqual([name, true]);
    }
  });

  it('переход по ссылке больше не ждёт, пока сообщение само загрузится', () => {
    // Раньше оба экрана выходили из перехода по ссылке, если сообщения нет в
    // окне; ждать теперь нужно только первую страницу.
    const chat = CHAT();
    const at = chat.indexOf('const initialJumpDoneRef = useRef(false);');
    expect(at).toBeGreaterThan(0);
    const body = chat.slice(at, at + 520);
    expect(body).not.toContain('const found = lines.some((m) => m.id === initialJumpMsgId);');
    expect(body).toContain('scrollToReply(initialJumpMsgId)');

    const groups = GROUPS();
    const gAt = groups.indexOf('const grpInitialJumpDoneRef = useRef(false);');
    expect(gAt).toBeGreaterThan(0);
    const gBody = groups.slice(gAt, gAt + 520);
    expect(gBody).toContain('if (displayGroupMessages.length === 0) return;');
    expect(gBody).not.toContain('if (!found) return;');
  });
});
