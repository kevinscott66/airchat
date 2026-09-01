/**
 * Автоудаление по умолчанию для новых разговоров.
 *
 * Решение ведёт к удалению переписки, поэтому обе его половины закреплены
 * тестами: разбор значения из kv (нижняя граница защищает от мусора, который
 * стёр бы чат сразу) и признак «разговор новый» (строка появляется раньше
 * первого сообщения, если контакт закрепили/заглушили/начали черновик).
 */

import {
  parseAutoDeleteMs,
  shouldApplyDefaultAutoDelete,
  MIN_AUTO_DELETE_MS,
  MAX_AUTO_DELETE_MS,
} from '../autoDeletePolicy';

describe('parseAutoDeleteMs', () => {
  it('принимает значения экрана настроек', () => {
    for (const ms of [60_000, 3_600_000, 86_400_000, 7 * 86_400_000]) {
      expect(parseAutoDeleteMs(String(ms))).toBe(ms);
    }
  });

  it('пустое и отсутствующее — выключено', () => {
    expect(parseAutoDeleteMs(null)).toBeNull();
    expect(parseAutoDeleteMs(undefined)).toBeNull();
    expect(parseAutoDeleteMs('')).toBeNull();
    expect(parseAutoDeleteMs('0')).toBeNull();
  });

  it('мусор не превращается в таймер', () => {
    expect(parseAutoDeleteMs('вчера')).toBeNull();
    expect(parseAutoDeleteMs('-60000')).toBeNull();
    // Ключевой случай: значение «1» дало бы таймер в миллисекунду, и первая же
    // переписка исчезла бы сразу после отправки.
    expect(parseAutoDeleteMs('1')).toBeNull();
    expect(parseAutoDeleteMs(String(MIN_AUTO_DELETE_MS - 1))).toBeNull();
    expect(parseAutoDeleteMs(String(MAX_AUTO_DELETE_MS + 1))).toBeNull();
  });

  it('границы включительно', () => {
    expect(parseAutoDeleteMs(String(MIN_AUTO_DELETE_MS))).toBe(MIN_AUTO_DELETE_MS);
    expect(parseAutoDeleteMs(String(MAX_AUTO_DELETE_MS))).toBe(MAX_AUTO_DELETE_MS);
  });
});

describe('shouldApplyDefaultAutoDelete', () => {
  const DAY = 86_400_000;

  it('выключенная настройка не трогает ничего', () => {
    for (const defaultMs of [null, 0]) {
      expect(shouldApplyDefaultAutoDelete({ defaultMs, exists: false, currentMs: null, lastMessageAt: null })).toBe(false);
    }
  });

  it('первое сообщение в новом разговоре получает значение по умолчанию', () => {
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: false, currentMs: null, lastMessageAt: null })).toBe(true);
  });

  it('строка без сообщений — тоже новый разговор', () => {
    // Разговор заводится и до переписки: закрепление, архив, «не беспокоить»,
    // сохранённый черновик. Иначе такие чаты навсегда остались бы без таймера.
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: 0 })).toBe(true);
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: null })).toBe(true);
  });

  it('переписка уже идёт — настройка задним числом не применяется', () => {
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: 1_700_000_000_000 })).toBe(false);
  });

  it('явное «Выкл» в чате сильнее значения по умолчанию', () => {
    // 0 — человек снял таймер руками; NULL — не выбирал ничего. Без этого
    // различия настройка возвращала бы автоудаление на каждое новое сообщение.
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: 0, lastMessageAt: 0 })).toBe(false);
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: 0, lastMessageAt: null })).toBe(false);
  });

  it('свой таймер чата не перезаписывается', () => {
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: 60_000, lastMessageAt: 0 })).toBe(false);
  });
});
