/**
 * Рэтчет к v4.32.565 — отложенное сообщение, которое не прочиталось.
 *
 * Проверяется и поведение решателя, и форма тех мест, где решение обязано
 * стоять: планировщик (не отправить и не удалить), чтение строки из базы
 * (состояние, а не пустая строка) и оба списка запланированных (подпись
 * вместо пустоты).
 *
 * `scheduledMessages.ts` здесь не импортируется: он тянет `uuid`, а тот
 * приезжает как ESM, который jest в этом проекте не преобразует. Форма его
 * исходника читается с диска.
 */

import fs from 'fs';
import path from 'path';
import {
  SCHEDULED_HOLD_LOG_CAP,
  decideScheduledSend,
  resetScheduledHoldLog,
  scheduledHoldTitle,
  scheduledReadState,
  shouldReportScheduledHold as shouldReport,
} from '../scheduledDispatch';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const DISPATCH = () => read('core', 'social', 'scheduledDispatch.ts');
const FLUSH = () => read('core', 'social', 'scheduledMessages.ts');
const LOCAL = () => read('core', 'storage', 'local.ts');
// v4.32.566: список был двумя одинаковыми файлами, стал одним общим —
// см. shared/__tests__/scheduledListModal.test.ts.
const LIST_MODAL = () => read('ui', 'components', 'modals', 'shared', 'ScheduledListModal.tsx');

/** Тело функции от её заголовка до первой закрывающей скобки в начале строки. */
function bodyOf(src: string, head: string): string {
  const at = src.indexOf(head);
  expect(at).toBeGreaterThanOrEqual(0);
  const end = src.indexOf('\n}\n', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

beforeEach(() => resetScheduledHoldLog());

describe('состояние строки расписания', () => {
  it('оба столбца прочитаны — строка целая', () => {
    expect(scheduledReadState({ text: 'plain', media: 'plain' })).toBe('ok');
  });

  it('вложений не было — это не поломка', () => {
    expect(scheduledReadState({ text: 'plain', media: 'absent' })).toBe('ok');
  });

  it('не открылся текст', () => {
    expect(scheduledReadState({ text: 'unreadable', media: 'absent' })).toBe('text_unreadable');
  });

  it('не открылись вложения', () => {
    expect(scheduledReadState({ text: 'plain', media: 'unreadable' })).toBe('media_unreadable');
  });

  it('текст важнее вложений: когда не открылось всё, названа причина потяжелее', () => {
    expect(scheduledReadState({ text: 'unreadable', media: 'unreadable' })).toBe('text_unreadable');
  });
});

describe('решение об отправке', () => {
  it('прочитанная строка уходит', () => {
    expect(decideScheduledSend({ text: 'привет', readState: 'ok' })).toEqual({ kind: 'send' });
  });

  it('строка без состояния считается прочитанной — старые вызывающие не ломаются', () => {
    expect(decideScheduledSend({ text: 'привет' })).toEqual({ kind: 'send' });
  });

  it('непрочитанный текст задерживается, а не уходит пустым', () => {
    expect(decideScheduledSend({ text: '', readState: 'text_unreadable' }))
      .toEqual({ kind: 'hold', code: 'text_unreadable' });
  });

  it('непрочитанные вложения задерживают сообщение целиком', () => {
    // Отправить текст без картинок — тоже необратимо: получатель не узнает,
    // что они были, а строка после отправки удаляется.
    expect(decideScheduledSend({ text: 'смотри', readState: 'media_unreadable' }))
      .toEqual({ kind: 'hold', code: 'media_unreadable' });
  });

  it('пустой текст задерживается даже без состояния — пустое в базу не кладут', () => {
    expect(decideScheduledSend({ text: '' })).toEqual({ kind: 'hold', code: 'text_empty' });
  });

  it('не строка — тоже отказ, а не отправка undefined', () => {
    expect(decideScheduledSend({ text: undefined as unknown as string }))
      .toEqual({ kind: 'hold', code: 'text_empty' });
  });
});

describe('подпись вместо текста', () => {
  it('про текст сказано, что он не открывается', () => {
    expect(scheduledHoldTitle('text_unreadable')).toBe('Сообщение не открывается — не отправится');
  });

  it('про вложение — своя строка', () => {
    expect(scheduledHoldTitle('media_unreadable')).toBe('Вложение не открывается — не отправится');
  });

  it('пустой текст подписан как непрочитанное сообщение, а не как «нет текста»', () => {
    expect(scheduledHoldTitle('text_empty')).toBe('Сообщение не открывается — не отправится');
  });

  it('ни одна подпись не обещает отправку', () => {
    for (const code of ['text_unreadable', 'media_unreadable', 'text_empty'] as const) {
      expect(scheduledHoldTitle(code)).toContain('не отправится');
    }
  });
});

describe('журнал отказов не повторяется', () => {
  it('первый отказ по строке виден, второй — нет', () => {
    expect(shouldReport('a')).toBe(true);
    expect(shouldReport('a')).toBe(false);
    expect(shouldReport('a')).toBe(false);
  });

  it('разные строки считаются по отдельности', () => {
    expect(shouldReport('a')).toBe(true);
    expect(shouldReport('b')).toBe(true);
  });

  it('сброс возвращает память в исходное', () => {
    expect(shouldReport('a')).toBe(true);
    resetScheduledHoldLog();
    expect(shouldReport('a')).toBe(true);
  });

  it('за потолком молчим, а не начинаем повторяться', () => {
    for (let i = 0; i < SCHEDULED_HOLD_LOG_CAP; i += 1) expect(shouldReport(`id${i}`)).toBe(true);
    expect(shouldReport('one-more')).toBe(false);
    // И не забыли уже сказанное ради нового: повторов по-прежнему нет.
    expect(shouldReport('id0')).toBe(false);
  });

  it('пустой id не занимает место в памяти', () => {
    expect(shouldReport('')).toBe(false);
  });
});

describe('форма исходников', () => {
  it('решатель ничего не импортирует', () => {
    const lines = DISPATCH().split('\n').filter((l) => /^import\s/.test(l));
    expect(lines).toEqual([]);
  });

  it('проход спрашивает решение и при отказе не идёт дальше', () => {
    const f = FLUSH();
    expect(f).toContain('const verdict = decideScheduledSend(msg);');
    expect(f).toContain("if (verdict.kind === 'hold') {");
  });

  it('проверка стоит раньше любой ветки, которая шлёт или удаляет', () => {
    const f = FLUSH();
    const guard = f.indexOf('const verdict = decideScheduledSend(msg);');
    expect(guard).toBeGreaterThan(0);
    for (const later of [
      'rateLimiter.isBlocked(msg.contactPubB64)',
      'await deleteScheduledMessage(msg.id);',
      'await fanoutGroupMessage(',
      'await svc.sendMessage(',
    ]) {
      expect(f.indexOf(later)).toBeGreaterThan(guard);
    }
  });

  it('отказ не удаляет строку: между проверкой и следующей веткой нет DELETE', () => {
    const f = FLUSH();
    const guard = f.indexOf('const verdict = decideScheduledSend(msg);');
    const next = f.indexOf('rateLimiter.isBlocked(msg.contactPubB64)');
    expect(f.slice(guard, next)).not.toContain('deleteScheduledMessage');
  });

  it('чтение строки из базы идёт состоянием, а не пустой строкой', () => {
    const b = bodyOf(LOCAL(), 'function rowToScheduled(');
    expect(b).toContain('readAtRestCell(r.text ?? null, dek)');
    expect(b).toContain('readAtRestCell(r.media_cids ?? null, dek)');
    expect(b).toContain('readState: scheduledReadState({ text: textCell.state, media: mediaCell.state })');
    // Именно эти два вызова и превращали неудачу в «настоящий текст».
    expect(b).not.toContain('decryptAtRestString(r.text, dek)');
    expect(b).not.toContain('decryptAtRestNullable(r.media_cids, dek)');
  });

  it('список запланированных показывает причину, а не пустую строку', () => {
    const m = LIST_MODAL();
    expect(m).toContain('scheduledHoldTitle(held.code)');
    expect(m).toContain('const verdict = decideScheduledSend(item);');
    // Прежняя безусловная отрисовка текста убрана целиком.
    expect(m).not.toContain('>{item.text}</Text>');
  });
});
