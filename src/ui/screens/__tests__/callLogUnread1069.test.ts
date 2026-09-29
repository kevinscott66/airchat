/**
 * Непрочитанный журнал звонков показывался как «Нет звонков» (v4.32.1069).
 *
 * ДЕФЕКТ. Служба звонков различает три состояния столбца с v4.32.979: журнал
 * прочитан, журнала нет, журнал не открылся. Третье она держит отметкой
 * `callLogUnreadableFor` и по ней запрещает запись — иначе первый же входящий
 * кладёт одну строку поверх сотни. Наружу отметку не отдавали. История звонков
 * на экране «Профиль» строится по одной только памяти (`getCallLog()`), а в
 * памяти после несостоявшегося чтения пусто — и окно рисовало значок трубки с
 * подписью «Нет звонков».
 *
 * ЦЕНА. Журнал — это кому звонили, когда и чем кончилось: до ста записей,
 * которые больше нигде не лежат. Человек, открывший историю, чтобы свериться
 * («звонил ли он мне?», «когда это было?»), получал утверждение, а не
 * незнание, и уходил с обратным выводом. Столбец не открывается чаще всего в
 * первую секунду после запуска — ровно тогда, когда в историю и заглядывают
 * после пропущенного.
 *
 * Второй счёт — «Очистить». Если за этот запуск случился звонок, строка в
 * памяти появляется (`recordCallEnd` пишет в память до диска), кнопка
 * «Очистить» вместе с ней, а стирает она столбец целиком — вместе с сотней,
 * которой человек не видел и о которой ему не сказали.
 *
 * ПРАВКА. Служба отвечает на вопрос `callLogUnreadable()`, экран его задаёт, и
 * непрочитанный журнал назван своим именем: под трубкой — «Журнал не
 * прочитался» вместо «Нет звонков», ниже — что записи на месте, и «Повторить».
 * Когда строки этого запуска всё же есть, текст стоит над ними и говорит про
 * «Очистить» прямо.
 *
 * ГРАНИЦЫ. Прочитанный и правда пустой журнал по-прежнему подписан «Нет
 * звонков» — это законный ответ у того, кто не звонил. «Повторить» показывается
 * только там, где показывать нечего: удачное чтение кладёт в память содержимое
 * столбца, и строки этого запуска, не легшие на диск, оно бы стёрло.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  callLogNotice,
  CALL_LOG_EMPTY_TITLE,
  CALL_LOG_RETRY,
  CALL_LOG_UNREAD_EMPTY,
  CALL_LOG_UNREAD_SHOWN,
  CALL_LOG_UNREAD_TITLE,
} from '../../utils/callLogUnread';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = join(__dirname, '..', '..', '..');
const PROFILE = (): string => codeOnly(readFileSync(join(SRC, 'ui', 'screens', 'ProfileScreen.tsx'), 'utf8'));
const SERVICE = (): string => codeOnly(readFileSync(join(SRC, 'core', 'social', 'callService.ts'), 'utf8'));

describe('что показать над историей звонков', () => {
  it('журнал прочитан — говорить нечего, сколько бы строк ни было', () => {
    expect(callLogNotice(false, 0)).toBe('none');
    expect(callLogNotice(false, 7)).toBe('none');
  });

  it('не прочитан и показывать нечего', () => {
    expect(callLogNotice(true, 0)).toBe('unread_empty');
  });

  it('не прочитан, но строки этого запуска есть', () => {
    expect(callLogNotice(true, 1)).toBe('unread_shown');
    expect(callLogNotice(true, 100)).toBe('unread_shown');
  });
});

describe('слова', () => {
  it('«нет звонков» и «не прочитался» — разные подписи', () => {
    expect(CALL_LOG_UNREAD_TITLE).not.toBe(CALL_LOG_EMPTY_TITLE);
    expect(CALL_LOG_UNREAD_TITLE).not.toContain('Нет звонков');
  });

  it('сказано, что записи на месте, а не пропали', () => {
    expect(CALL_LOG_UNREAD_EMPTY).toContain('записи на месте');
    // Без этой половины человек решит, что истории больше нет.
    expect(CALL_LOG_UNREAD_EMPTY).toContain('звонков не было');
  });

  it('про «Очистить» сказано прямо, пока список выглядит коротким', () => {
    expect(CALL_LOG_UNREAD_SHOWN).toContain('только звонки с этого запуска');
    expect(CALL_LOG_UNREAD_SHOWN).toContain('Очистить');
  });

  it('у повтора есть слово, и оно не пустое', () => {
    expect(CALL_LOG_RETRY.trim().length).toBeGreaterThan(0);
  });
});

describe('форма исходника службы звонков', () => {
  it('отметка отдаётся наружу и привязана к владельцу журнала', () => {
    const s = SERVICE();
    expect(s).toContain('export function callLogUnreadable(): boolean {');
    expect(s).toContain('return callProfileId !== null && callLogUnreadableFor === callProfileId;');
  });

  it('повторное чтение идёт тем же путём, что и первое', () => {
    const s = SERVICE();
    expect(s).toContain('export async function reloadCallLog(): Promise<boolean> {');
    expect(s).toContain('  await loadCallLog(pid);');
    expect(s).toContain('  return !callLogUnreadable();');
  });
});

describe('форма исходника экрана', () => {
  it('экран спрашивает службу, а не выводит состояние из пустоты', () => {
    const p = PROFILE();
    expect(p).toContain('const [callLogUnread, setCallLogUnread] = useState(() => callLogUnreadable());');
    expect(p).toContain('const callNotice = callLogNotice(callLogUnread, callLogEntries.length);');
    // Окно открывают кнопкой, и снимок берут там же, где список.
    expect(p).toContain('            setCallLogEntries(getCallLog());\n            setCallLogUnread(callLogUnreadable());');
  });

  it('подпись под трубкой выбирается исходом, а не стоит намертво', () => {
    const p = PROFILE();
    expect(p).toContain("{callNotice === 'unread_empty' ? CALL_LOG_UNREAD_TITLE : CALL_LOG_EMPTY_TITLE}");
    // Прежней вшитой строки на экране не осталось: она уехала в правило.
    expect(p).not.toContain('>Нет звонков<');
  });

  it('оба текста показаны янтарём — вторым сигналом, а не обычной подписью', () => {
    const p = PROFILE();
    for (const id of ['call_log_unread_empty', 'call_log_unread_shown']) {
      const at = p.indexOf(`testID="${id}"`);
      expect(at).toBeGreaterThan(0);
      expect(p.slice(at - 260, at)).toContain('colors.warning');
    }
  });

  it('«Повторить» стоит только там, где терять нечего', () => {
    const p = PROFILE();
    const at = p.indexOf('testID="call_log_unread_retry"');
    expect(at).toBeGreaterThan(0);
    const block = p.slice(p.indexOf("{callNotice === 'unread_empty' ? (") , at);
    expect(block).toContain('void reloadCallLog().then((ok) => {');
    expect(block).toContain('setCallLogUnread(!ok);');
    // И только в ветке пустого списка: у «unread_shown» одни слова, без кнопки.
    const shownAt = p.indexOf('testID="call_log_unread_shown"');
    expect(shownAt).toBeGreaterThan(0);
    const shownEnd = p.indexOf(') : null}', shownAt);
    expect(shownEnd).toBeGreaterThan(shownAt);
    expect(p.slice(shownAt, shownEnd)).not.toContain('reloadCallLog');
    expect(p.slice(shownAt, shownEnd)).not.toContain('AppPressable');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежнее поведение окна цело', () => {
  it('«Очистить» по-прежнему скрыта у пустого списка и говорит о неудаче', () => {
    const p = PROFILE();
    expect(p).toContain('{callLogEntries.length > 0 ? (');
    expect(p).toContain("Alert.alert('История звонков', 'Не удалось очистить: хранилище занято. Попробуйте ещё раз.');");
  });

  it('подписи исходов звонка не тронуты', () => {
    const p = PROFILE();
    expect(p).toContain("? 'Не соединились'");
    expect(p).toContain("? (isOut ? 'Нет ответа' : 'Пропущен')");
    expect(p).toContain(": 'Отклонён';");
  });

  it('снимок журнала всё так же берётся при открытии окна', () => {
    const p = PROFILE();
    expect(p).toContain('testID="btn_call_log"');
    expect(p).toContain('setCallLogVisible(true);');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отметка так и запрещает запись поверх непрочитанного', () => {
    const s = SERVICE();
    expect(s).toContain('    if (callLogUnreadableFor === profileId) {');
    expect(s).toContain('      callLogUnreadableFor = pid;');
  });

  it('в памяти после несостоявшегося чтения по-прежнему пусто', () => {
    const s = SERVICE();
    // `loadCallLog` уходит наверх, не тронув `callLog`, — значит по одному
    // только списку отличить «не читали» от «звонков не было» нельзя.
    const at = s.indexOf("      log.warn('call_log_unreadable', { pid });");
    expect(at).toBeGreaterThan(0);
    expect(s.slice(at, at + 80)).toContain('return;');
    expect(s).toContain('export function getCallLog(): CallLogEntry[] {\n  return [...callLog];\n}');
  });
});

describe('ЗАКРЕПКА', () => {
  it('правило лежит отдельно от экрана и без импортов', () => {
    const rule = readFileSync(join(SRC, 'ui', 'utils', 'callLogUnread.ts'), 'utf8');
    expect(codeOnly(rule)).not.toContain('import ');
  });
});
