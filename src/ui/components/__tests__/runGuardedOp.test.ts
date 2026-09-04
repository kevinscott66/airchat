/**
 * v4.32.546. Действия над сообщениями были записаны как
 * `void doSomething(...).then(перерисовать)` — без `.catch`. Хранилище бросает
 * на занятой базе, сорванной транзакции, отсутствующем профиле, и отказ уходил
 * в неперехваченное отклонение обещания: ни перерисовки, ни ошибки. «Удалить»
 * и «В избранное» выглядели как кнопки, которые иногда просто не срабатывают.
 *
 * В группах защита стояла с v4.32.531, но жила внутри GroupsScreen — переписка
 * оставалась открытой. Проверяется и поведение обёртки, и форма исходников:
 * что незакрытых цепочек в этих экранах не осталось.
 */
import fs from 'fs';
import path from 'path';

const shownErrors: string[] = [];
jest.mock('../userFeedback', () => ({
  showError: (m: string) => { shownErrors.push(m); },
  showSuccess: jest.fn(),
  reportTwoSided: jest.fn(),
}));

const loggedErrors: Array<{ tag: string; meta: unknown }> = [];
jest.mock('../../../core/logger', () => ({
  log: {
    error: (tag: string, meta: unknown) => { loggedErrors.push({ tag, meta }); },
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { runGuardedOp } from '../runGuardedOp';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

const CHAT = read('ui/screens/ChatScreen.tsx');
const GROUPS = read('ui/screens/GroupsScreen.tsx');
const MOD = read('ui/components/runGuardedOp.ts');

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  shownErrors.length = 0;
  loggedErrors.length = 0;
});

describe('runGuardedOp', () => {
  it('успешное действие ничего не показывает', async () => {
    let ran = false;
    runGuardedOp(async () => { ran = true; }, 'запас');
    await flush();
    expect(ran).toBe(true);
    expect(shownErrors).toEqual([]);
    expect(loggedErrors).toEqual([]);
  });

  it('отказ показывается человеку, а не пропадает', async () => {
    runGuardedOp(async () => { throw new Error('database is locked'); }, 'Не удалось удалить');
    await flush();
    // Чужой машинный текст на экран не идёт — уходит запасной.
    expect(shownErrors).toEqual(['Не удалось удалить']);
  });

  it('наш собственный русский текст доходит до человека как есть', async () => {
    runGuardedOp(async () => { throw new Error('Сообщение слишком длинное'); }, 'запас');
    await flush();
    expect(shownErrors).toEqual(['Сообщение слишком длинное']);
  });

  it('с меткой причина попадает в журнал', async () => {
    runGuardedOp(async () => { throw new Error('database is locked'); }, 'запас', 'ui_test_failed');
    await flush();
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0].tag).toBe('ui_test_failed');
    expect(loggedErrors[0].meta).toEqual({ err: 'database is locked' });
  });

  it('без метки в журнал не пишет, но человеку показывает', async () => {
    runGuardedOp(async () => { throw new Error('database is locked'); }, 'запас');
    await flush();
    expect(loggedErrors).toEqual([]);
    expect(shownErrors).toHaveLength(1);
  });

  it('отказ не выходит наружу неперехваченным отклонением', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    runGuardedOp(async () => { throw new Error('бум'); }, 'запас');
    await flush();
    await flush();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('то, что после действия, при отказе не выполняется', async () => {
    let after = false;
    runGuardedOp(async () => {
      throw new Error('бум');
      // eslint-disable-next-line no-unreachable
      after = true;
    }, 'запас');
    await flush();
    expect(after).toBe(false);
    expect(shownErrors).toHaveLength(1);
  });
});

describe('незакрытых цепочек в экранах не осталось', () => {
  it('оба экрана зовут общий модуль, а своей копии нет', () => {
    for (const src of [CHAT, GROUPS]) {
      expect(src).toContain("from '../components/runGuardedOp'");
      expect(src).not.toContain('function runGuardedOp(');
    }
  });

  it('обёртка сама пишет и в журнал, и на экран', () => {
    expect(MOD).toContain('showError(userErrorText(e, fallback))');
    expect(MOD).toContain('log.error(tag,');
  });

  it('действия над сообщениями не висят на голом void .then()', () => {
    const banned = [
      /void setMessageStarred\([^)]*\)\.then\(/,
      /void svc2?\.deleteMessage(Locally|ForEveryone)\([^)]*\)\.then\(/,
      /void deleteScheduledMessage\([^)]*\)\.then\(/,
      /void rateLimiter\.(un)?blockContact\([^)]*\)\.then\(/,
      /void Promise\.all\([^\n]*\)\s*\n?\s*\.then\(/,
    ];
    for (const [name, src] of [['ChatScreen', CHAT], ['GroupsScreen', GROUPS]] as const) {
      for (const re of banned) {
        expect({ name, re: String(re), hit: re.test(src) }).toEqual({
          name,
          re: String(re),
          hit: false,
        });
      }
    }
  });

  it('у каждого закрытого места есть метка для журнала', () => {
    const tags = CHAT.match(/runGuardedOp\(/g) ?? [];
    const withTag = CHAT.match(/, 'ui_chat_[a-z_]+'\)/g) ?? [];
    // Все места переписки помечены; без метки причина не ищется.
    // v4.32.578: было одиннадцать — двойник «В избранное» из отдельного
    // iOS-меню ушёл вместе с меню, а не с обработкой ошибки.
    expect(tags.length).toBeGreaterThanOrEqual(10);
    expect(withTag.length).toBeGreaterThanOrEqual(10);
  });
});
