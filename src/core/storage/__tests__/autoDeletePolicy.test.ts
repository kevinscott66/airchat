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
      expect(shouldApplyDefaultAutoDelete({ defaultMs, exists: false, currentMs: null, lastMessageAt: null, pendingDefault: false })).toBe(false);
    }
  });

  it('первое сообщение в новом разговоре получает значение по умолчанию', () => {
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: false, currentMs: null, lastMessageAt: null, pendingDefault: false })).toBe(true);
  });

  it('строка без сообщений — тоже новый разговор', () => {
    // Разговор заводится и до переписки: закрепление, архив, «не беспокоить»,
    // сохранённый черновик. Иначе такие чаты навсегда остались бы без таймера.
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: 0, pendingDefault: false })).toBe(true);
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: null, pendingDefault: false })).toBe(true);
  });

  it('переписка уже идёт — настройка задним числом не применяется', () => {
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: 1_700_000_000_000, pendingDefault: false })).toBe(false);
  });

  it('явное «Выкл» в чате сильнее значения по умолчанию', () => {
    // 0 — человек снял таймер руками; NULL — не выбирал ничего. Без этого
    // различия настройка возвращала бы автоудаление на каждое новое сообщение.
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: 0, lastMessageAt: 0, pendingDefault: false })).toBe(false);
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: 0, lastMessageAt: null, pendingDefault: false })).toBe(false);
  });

  it('свой таймер чата не перезаписывается', () => {
    expect(shouldApplyDefaultAutoDelete({ defaultMs: DAY, exists: true, currentMs: 60_000, lastMessageAt: 0, pendingDefault: false })).toBe(false);
  });
});

/**
 * Отсрочка для непрочитанной настройки (v4.32.1037).
 *
 * ДЕФЕКТ. Правило одноразовое: срабатывает на первом сообщении разговора и
 * больше не возвращается. `prepareConvTouch` читал настройку короткой формой,
 * которая отвечает одним `null` и на «выключено», и на «прочитать не смогли»,
 * — и второй ответ закрывал окно так же насовсем, как первый.
 *
 * ЦЕНА. Разговор навсегда остаётся без таймера, а выглядит как обычный:
 * плашки «Исчезают через …» у чата без автоудаления нет и быть не должно.
 * Человек, включивший автоудаление новых чатов, пишет в него как в
 * исчезающий, и сообщения остаются на диске и уезжают в облачную копию.
 *
 * ПРАВКА. Провал чтения окно не закрывает: разговор помечается должником, и
 * первое же удачное чтение доделывает начатое.
 *
 * ГРАНИЦЫ. Отсрочка слабее любого решения человека: явный таймер и явное
 * «Выкл» проверяются раньше неё. Она не делает умолчание применимым к старой
 * переписке — только к той, у которой первая попытка сорвалась.
 */
describe('отсрочка, когда настройку не прочитали', () => {
  const DAY = 86_400_000;
  const YESTERDAY = 1_700_000_000_000;

  it('должнику умолчание достаётся со второй попытки', () => {
    expect(shouldApplyDefaultAutoDelete({
      defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: YESTERDAY, pendingDefault: true,
    })).toBe(true);
  });

  it('проверка не пустая: без отметки тот же разговор остаётся ни с чем', () => {
    expect(shouldApplyDefaultAutoDelete({
      defaultMs: DAY, exists: true, currentMs: null, lastMessageAt: YESTERDAY, pendingDefault: false,
    })).toBe(false);
  });

  it('выбор человека сильнее отсрочки', () => {
    // 0 — снял таймер руками. Долг не повод вернуть его втихую.
    expect(shouldApplyDefaultAutoDelete({
      defaultMs: DAY, exists: true, currentMs: 0, lastMessageAt: YESTERDAY, pendingDefault: true,
    })).toBe(false);
    expect(shouldApplyDefaultAutoDelete({
      defaultMs: DAY, exists: true, currentMs: 60_000, lastMessageAt: YESTERDAY, pendingDefault: true,
    })).toBe(false);
  });

  it('выключенная настройка долгом не воскресает', () => {
    for (const defaultMs of [null, 0]) {
      expect(shouldApplyDefaultAutoDelete({
        defaultMs, exists: true, currentMs: null, lastMessageAt: YESTERDAY, pendingDefault: true,
      })).toBe(false);
    }
  });
});
