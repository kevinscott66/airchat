/**
 * Личность звонящего не показывается поверх запертого замка (v4.32.627).
 *
 * CallOverlay рисуется РЯДОМ с экраном пароля (App.tsx), а не внутри
 * разблокированной ветки, поэтому входящий звонок выкладывал имя звонящего во
 * весь экран запертого приложения — и для этого ещё поднимал зашифрованную
 * книгу контактов. То же правило, что у баннеров (previewAllowed), тут не
 * действовало вовсе.
 *
 * Поведение считается на самом модуле callerDisplay: он без импортов. Сам
 * CallOverlay.tsx тянет expo-blur, svg и expo-audio, поэтому его подключение
 * проверяется по форме исходника.
 */
import fs from 'fs';
import path from 'path';
import { callerDisplay, HIDDEN_CALLER_NAME } from '../callerDisplay';
import { nameInitials } from '../../../core/social/contactLabel';

/** Исходник без строк-комментариев: в них старая форма упомянута нарочно. */
function bare(rel: string[]): string {
  return fs
    .readFileSync(path.join(__dirname, '..', ...rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

const OVERLAY = bare(['CallOverlay.tsx']);
const APP = bare(['..', '..', 'App.tsx']);

describe('под замком имени звонящего нет', () => {
  it('заперто — вместо имени подпись, вместо инициалов вопрос', () => {
    const who = callerDisplay(true, 'Рита');
    expect(who.name).toBe(HIDDEN_CALLER_NAME);
    expect(who.name).not.toContain('Рита');
    expect(who.avatarName).toBe('');
    // Пустое имя аватара — это «?», а не чьи-то инициалы.
    expect(nameInitials(who.avatarName)).toBe('?');
  });

  it('открыто — имя показывается как есть', () => {
    expect(callerDisplay(false, 'Рита')).toEqual({ name: 'Рита', avatarName: 'Рита' });
    expect(nameInitials(callerDisplay(false, 'Рита').avatarName)).not.toBe('?');
  });

  it('под замком имя скрыто при любом входном имени', () => {
    for (const n of ['', 'A', 'Alexander Ivanov', 'AbCdEf123456']) {
      expect(callerDisplay(true, n).name).toBe(HIDDEN_CALLER_NAME);
      expect(callerDisplay(true, n).avatarName).toBe('');
    }
  });
});

describe('оверлей знает про замок и пользуется решением', () => {
  it('имя приходит только через callerDisplay', () => {
    expect(OVERLAY).toContain("import { callerDisplay, type CallerDisplay } from './callerDisplay';");
    expect(OVERLAY).toContain('const who = callerDisplay(locked, call.peerName);');
    // Единственное место, где call.peerName вообще читается.
    expect(OVERLAY.split('call.peerName').length - 1).toBe(1);
    expect(OVERLAY).toContain('export function CallOverlay({ locked }: { locked: boolean })');
  });

  it('все три места рисования берут имя из решения', () => {
    expect(OVERLAY).toContain('{who.name}</Text>');
    expect(OVERLAY.split('{who.name}</Text>').length - 1).toBe(3);
    expect(OVERLAY.split('name={who.avatarName}').length - 1).toBe(2);
  });

  it('книга контактов под замком не читается', () => {
    const from = OVERLAY.indexOf('const nameResolvedForRef');
    expect(from).toBeGreaterThan(0);
    const to = OVERLAY.indexOf('}, [call?.peerPubB64, call?.state, locked]);', from);
    expect(to).toBeGreaterThan(from);
    const effect = OVERLAY.slice(from, to);
    expect(effect).toContain('await listContacts()');
    // Выход раньше чтения — и по замку тоже.
    const guard = effect.indexOf('if (locked || call?.state !== ');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(effect.indexOf('await listContacts()'));
  });

  it('App передаёт состояние замка', () => {
    expect(APP).toContain('<CallOverlay locked={!appUnlocked} />');
  });
});

describe('отказ хранилища ключей при возвращении решается в пользу замка', () => {
  it('hasPassword обёрнут, а отказ падает на последнее удачное чтение', () => {
    const from = APP.indexOf('let hasPwd: boolean;');
    expect(from).toBeGreaterThan(0);
    const to = APP.indexOf('if (!hasPwd) return;', from);
    expect(to).toBeGreaterThan(from);
    const block = APP.slice(from, to);
    expect(block).toContain('try {');
    expect(block).toContain('hasPwd = await authGuard.hasPassword();');
    expect(block).toContain('hadPasswordRef.current = hasPwd;');
    expect(block).toContain('} catch {');
    expect(block).toContain('hasPwd = hadPasswordRef.current;');
  });

  it('загрузочная проверка тоже запоминает, был ли пароль', () => {
    expect(APP).toContain('const hadPasswordRef = useRef(false);');
    // Два места пишут ref: загрузка и возвращение. Без загрузочного отказ
    // после перезапуска решался бы в пользу «пароля не было».
    expect(APP.split('hadPasswordRef.current = hasPwd;').length - 1).toBe(2);
  });
});

it('ПРОВЕРКА НЕ ПУСТАЯ: файлы прочитаны, и старая форма в них действительно отсутствует', () => {
  expect(OVERLAY.length).toBeGreaterThan(5000);
  expect(APP.length).toBeGreaterThan(50000);
  expect(OVERLAY).toContain('<CallerAvatar');
  expect(OVERLAY).not.toContain('{call.peerName}</Text>');
  expect(OVERLAY).not.toContain('name={call.peerName}');
  expect(APP).not.toContain('<CallOverlay />');
});
