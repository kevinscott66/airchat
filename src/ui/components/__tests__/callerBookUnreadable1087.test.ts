/**
 * ДЕФЕКТ. Имя звонящего экран поднимал из книги контактов через
 * `listContacts()`. Эта обёртка на отказ чтения отдаёт пустой список —
 * `(await listContactsReadFor(...)) ?? []`, — и «книгу не удалось открыть»
 * приходило на экран неотличимо от «этого человека нет в контактах».
 * Вдобавок отметка `nameResolvedForRef.current = peer` ставилась ДО чтения:
 * один неудачный проход, и имя не подтягивалось до конца звонка.
 *
 * ЦЕНА. Запасное имя звонка — `fromPubB64.slice(0, 12)`, двенадцать знаков
 * открытого ключа. На весь экран входящего звонка вместо имени близкого
 * человека выкладывался обрубок ключа: это читается как «звонит кто-то
 * незнакомый», а такой звонок отклоняют. Книга не читается ровно в том
 * случае, который случается каждый день, — телефон не разблокировали после
 * перезагрузки, и Keychain отказывает; секундой позже она бы открылась, но
 * отметка уже стояла, и повтора не было.
 *
 * ПРАВКА. Чтение идёт честной парой `listContactsRead()`: `null` — отказ,
 * `[]` — пустая книга. На отказе отметка снимается (повтор на ближайшей
 * смене замка или состояния звонка) и поднимается отдельное состояние, из
 * которого `callerDisplay` даёт третью подпись — «Имя не прочитано».
 *
 * ГРАНИЦЫ. Замок остаётся первым: под ним не показывают ничего, включая и
 * то, что имя не прочиталось (v4.32.627). Книга под замком по-прежнему не
 * читается вовсе.
 */
import fs from 'fs';
import path from 'path';
import {
  callerDisplay,
  HIDDEN_CALLER_NAME,
  UNREADABLE_CALLER_NAME,
} from '../callerDisplay';
import { nameInitials } from '../../../core/social/contactLabel';

const root = path.resolve(__dirname, '../../../..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  if (a < 0) throw new Error(`не нашли начало: ${from}`);
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const OVERLAY = (): string => read('src/ui/components/CallOverlay.tsx');
const CONTACTS = (): string => read('src/core/social/contacts.ts');
const SERVICE = (): string => read('src/core/social/callService.ts');

/** Тело действия, которое поднимает имя звонящего. */
const resolver = (): string =>
  slice(
    codeOnly(OVERLAY()),
    'const nameResolvedForRef',
    '}, [call?.peerPubB64, call?.state, locked]);'
  );

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  test('исходники прочитаны, якоря найдены', () => {
    expect(OVERLAY().length).toBeGreaterThan(5000);
    expect(resolver().length).toBeGreaterThan(200);
  });

  test('решение о подписи по-прежнему одно на экран', () => {
    // Про ФОРМУ решения здесь ничего: закрепка обязана проходить и на
    // старом коде. Проверяем лишь, что вход один.
    expect(codeOnly(OVERLAY())).toContain('callerDisplay(locked, call.peerName');
    expect(codeOnly(OVERLAY()).split('call.peerName').length - 1).toBe(1);
  });
});

describe('форма правки', () => {
  test('третий вход решения приходит с экрана', () => {
    expect(codeOnly(OVERLAY())).toContain('callerDisplay(locked, call.peerName, bookUnreadable)');
  });

  test('третий вход обязателен, а не с умолчанием', () => {
    const src = read('src/ui/components/callerDisplay.ts');
    expect(src).toContain('bookUnreadable: boolean');
    expect(src).not.toContain('bookUnreadable = false');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  test('listContacts всё ещё выдаёт отказ за пустую книгу', () => {
    expect(CONTACTS()).toContain('return (await listContactsReadFor(ownerProfileId)) ?? [];');
  });

  test('честная пара для чтения книги существует', () => {
    expect(CONTACTS()).toContain('export async function listContactsRead(): Promise<Contact[] | null>');
  });

  test('запасное имя звонка — обрубок открытого ключа', () => {
    expect(SERVICE()).toContain('peerName: fromPubB64.slice(0, 12),');
  });

  test('отметка о разобранном имени ставится до чтения', () => {
    const body = resolver();
    expect(body).toContain('nameResolvedForRef.current = peer;');
    expect(body.indexOf('nameResolvedForRef.current = peer;')).toBeLessThan(
      body.indexOf('await listContacts')
    );
  });
});

describe('«книгу не прочитали» — не «его нет в контактах»', () => {
  test('у отказа своя подпись, и это не имя и не «скрыто»', () => {
    const who = callerDisplay(false, 'a1b2c3d4e5f6', true);
    expect(who.name).toBe(UNREADABLE_CALLER_NAME);
    expect(who.name).not.toBe(HIDDEN_CALLER_NAME);
    expect(who.name).not.toContain('a1b2c3d4e5f6');
    expect(UNREADABLE_CALLER_NAME.trim().length).toBeGreaterThan(0);
  });

  test('обрубок ключа на экран больше не попадает', () => {
    // Ровно тот случай: книга не открылась, имени нет, peerName — ключ.
    expect(callerDisplay(false, 'AbCdEf123456', true).name).not.toBe('AbCdEf123456');
    // А когда книга открылась и человека в ней нет — показываем как есть.
    expect(callerDisplay(false, 'AbCdEf123456', false).name).toBe('AbCdEf123456');
  });

  test('в кружке вопрос, а не выдуманные инициалы', () => {
    expect(callerDisplay(false, 'Рита', true).avatarName).toBe('');
    expect(nameInitials(callerDisplay(false, 'Рита', true).avatarName)).toBe('?');
  });

  test('экран читает книгу честной парой', () => {
    const body = resolver();
    expect(body).toContain('await listContactsRead()');
    expect(body).not.toContain('await listContacts()');
    expect(body).toContain('if (contacts === null)');
  });

  test('отказ поднимает отдельное состояние и снимает отметку', () => {
    const body = resolver();
    expect(body).toContain('setBookUnreadable(true);');
    expect(body).toContain('nameResolvedForRef.current = null;');
    // Снятие отметки идёт вместе с отказом, а не только при смене
    // собеседника: без этого повтора не будет.
    const failure = slice(body, 'const failed = (error: unknown)', '};');
    expect(failure).toContain('nameResolvedForRef.current = null;');
    expect(failure).toContain('setBookUnreadable(true);');
  });

  test('удачное чтение отказ снимает', () => {
    // Снятие ищем на удачном пути, а не в сбросе при смене собеседника:
    // там такой же вызов, и закрепка прошла бы вхолостую.
    const ok = slice(resolver(), 'if (contacts === null)', '})();');
    expect(ok).toContain('setBookUnreadable(false);');
    expect(ok).toContain('updateIncomingCallerName(peer, name);');
  });

  test('брошенная ошибка идёт тем же путём, что и null', () => {
    const body = resolver();
    expect(body).toContain('} catch (error) {');
    const tail = slice(body, '} catch (error) {', '})();');
    expect(tail).toContain('failed(error);');
  });

  test('состояние обнуляется при смене собеседника', () => {
    const body = resolver();
    const head = slice(body, 'if (!peer) {', '}');
    expect(head).toContain('setBookUnreadable(false);');
  });
});

describe('ГРАНИЦА: замок остаётся первым', () => {
  test('под замком не видно и того, что имя не прочиталось', () => {
    for (const unreadable of [false, true]) {
      expect(callerDisplay(true, 'Рита', unreadable).name).toBe(HIDDEN_CALLER_NAME);
      expect(callerDisplay(true, 'Рита', unreadable).avatarName).toBe('');
    }
  });

  test('книга под замком по-прежнему не читается', () => {
    // Якорь по смыслу («чтение книги»), а не по нынешнему написанию:
    // правило про замок старше этой правки и обязано держаться в обеих
    // редакциях.
    const body = resolver();
    const guard = body.indexOf('if (locked || call?.state !== ');
    const readsBook = body.indexOf('await listContacts');
    expect(guard).toBeGreaterThan(0);
    expect(readsBook).toBeGreaterThan(0);
    expect(guard).toBeLessThan(readsBook);
  });

  test('открытый замок с читаемой книгой ничего не меняет', () => {
    expect(callerDisplay(false, 'Рита', false)).toEqual({ name: 'Рита', avatarName: 'Рита' });
  });
});
