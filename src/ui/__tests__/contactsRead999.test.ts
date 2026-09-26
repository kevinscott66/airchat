/**
 * Адресная книга: «Нет контактов» и пропущенная проверка на дубликат.
 *
 * Дефект. `listContacts` отдаёт пустой список и когда контактов нет, и когда
 * их не удалось прочитать, — тело переехало в `listContactsRead` ещё в
 * v4.32.534, но четыре места звали короткое имя и потому пустоту от отказа не
 * отличали.
 *
 * Цена. Три из четырёх мест говорили неправду вслух: вкладка «Контакт» в
 * листе вложений и список рассылки отвечали «Нет контактов», карточка
 * «Контакты» в профиле показывала 0 — при целой книге на диске. Четвёртое
 * место молчало и делало хуже: окно добавления искало в пустом списке уже
 * заведённый контакт, не находило и шло добавлять. Дальше
 * `mergeExplicitContactRow` берёт `displayName` из патча, а патч здесь
 * непустой всегда («Новый контакт», если поле не заполнено), — и у знакомого
 * контакта менялось имя вместо окна «Контакт уже добавлен». Против этого
 * «фантомного повторного добавления» проверку и завели в v4.32.44.
 *
 * Правка (v4.32.999). Все четыре места читают `listContactsRead`. Два списка
 * печатают `UNREADABLE_CONTACTS_TEXT`, счётчик в профиле не трогают (как и
 * счётчик публикаций строкой выше), окно добавления отказывается добавлять и
 * называет причину. Список чатов на сбое показывает последнюю прочитанную
 * книгу, а не теряет строки контактов без переписки.
 *
 * Границы. Пустая книга по-прежнему называется «Нет контактов»; гасящий
 * `listContacts` остаётся для тех, кому разница не нужна (имена в журнале
 * звонков, подписи в карточках).
 */

import fs from 'fs';
import path from 'path';
import { UNREADABLE_CONTACTS_TEXT } from '../../core/storage/unreadableText';

const SRC = path.join(__dirname, '..', '..');
const read = (...rel: string[]): string => fs.readFileSync(path.join(SRC, ...rel), 'utf8');
const ATTACH = (): string => read('ui', 'components', 'AttachSheet.tsx');
const CHATLIST = (): string => read('ui', 'screens', 'ChatListScreen.tsx');
const PROFILE = (): string => read('ui', 'screens', 'ProfileScreen.tsx');
const CONTACTS = (): string => read('core', 'social', 'contacts.ts');
const MERGE = (): string => read('core', 'social', 'contactRowMerge.ts');

/** Без строк-комментариев: иначе объяснение правки само проходит проверку. */
function codeOnly(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

/** Одно тело, чтобы утверждение не поймало совпадение у соседа. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('места, где книгу показывают человеку, читают её исходом', () => {
  it('вкладка «Контакт» отличает пустую книгу от непрочитанной', () => {
    const tab = codeOnly(slice(ATTACH(), 'function ContactTab({ onPick }', '\n}\n'));
    expect(tab).toContain('const list = await listContactsRead();');
    expect(tab).toContain('setReadFailed(list === null);');
    expect(tab).toContain('if (list !== null) setContacts(list);');
    expect(tab).toContain('readFailed');
    expect(tab).toContain('UNREADABLE_CONTACTS_TEXT');
    expect(tab).not.toContain('await listContacts()');
  });

  it('список рассылки не говорит «Нет контактов» на непрочитанную книгу', () => {
    const src = CHATLIST();
    expect(codeOnly(src)).toContain('UNREADABLE_CONTACTS_TEXT');
    expect(src).toContain('{contactsReadFailed');
    const load = codeOnly(slice(src, 'const loadData = useCallback(async () => {', '\n  }, ['));
    expect(load).toContain('listContactsRead(),');
    expect(load).toContain('setContactsReadFailed(ctactsRaw === null);');
    expect(load).not.toContain('listContacts(),');
  });

  it('список чатов на сбое показывает прежнюю книгу, а не пустую', () => {
    const load = codeOnly(slice(CHATLIST(), 'const loadData = useCallback(async () => {', '\n  }, ['));
    expect(load).toContain('const ctacts = ctactsRaw ?? lastContactsRef.current;');
    expect(load).toContain('if (ctactsRaw !== null) lastContactsRef.current = ctactsRaw;');
    expect(load).toContain('contacts: ctacts,');
    expect(load).not.toContain('contacts: ctactsRaw,');
  });

  it('окно добавления не добавляет, пока не прочитало книгу', () => {
    const src = codeOnly(CHATLIST());
    expect(src).toContain('const known = await listContactsRead();');
    expect(src).toContain('if (known === null) {');
    expect(src).toContain('const existing = known.find((c) => c.peerPublicKey === pkB64);');
    expect(src).not.toContain('(await listContacts()).find');
  });

  it('карточка «Контакты» в профиле не показывает 0 на непрочитанную книгу', () => {
    const src = codeOnly(PROFILE());
    expect(src).toContain('listContactsRead(),');
    expect(src).toContain('if (contacts !== null) {');
    expect(src).toContain('if (!alive || contacts === null) return;');
    expect(src).not.toContain('listContacts()');
  });

  it('пометка названа про книгу, а не про одну строку в ней', () => {
    expect(UNREADABLE_CONTACTS_TEXT).toBe('Контакты не удалось прочитать');
    expect(UNREADABLE_CONTACTS_TEXT).not.toContain('Контакт ');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('короткое имя и правда гасит отказ в пустой список', () => {
    const src = CONTACTS();
    expect(src).toContain('export async function listContacts(): Promise<Contact[]> {\n  return listContactsFor(activeProfileId());');
    const body = slice(src, 'export async function listContactsFor(', '\n}\n');
    expect(body).toContain('return (await listContactsReadFor(ownerProfileId)) ?? [];');
  });

  it('трёхсостоянийный вход на месте и обещает null именно на отказе', () => {
    const src = CONTACTS();
    expect(src).toContain('export async function listContactsRead(): Promise<Contact[] | null>');
  });

  it('слияние строки и правда ставит имя из патча поверх прежнего', () => {
    const body = slice(MERGE(), 'export function mergeExplicitContactRow(', '\n}\n');
    expect(body).toContain("const displayName = patch.displayName || readString(prev, 'displayName');");
  });

  it('прочитанная пустота по-прежнему называется своими словами', () => {
    // Надпись проверяется без кавычек: до правки в списке рассылки она стояла
    // прямо в разметке, после — в ветке условия. Слова те же, и это здесь
    // важно: блок держится на обеих версиях кода.
    expect(ATTACH()).toContain('Нет контактов');
    expect(CHATLIST()).toContain('Нет контактов');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: показ книги на месте', () => {
  it('вкладка «Контакт» по-прежнему рисует список и отдаёт выбранного', () => {
    const tab = slice(ATTACH(), 'function ContactTab({ onPick }', '\n}\n');
    expect(tab).toContain('onPress={() => onPick(item)}');
    expect(tab).toContain('keyExtractor={(c) => c.peerPublicKey}');
  });

  it('рассылка по-прежнему берёт список контактов экрана', () => {
    const src = CHATLIST();
    expect(src).toContain('data={contacts}');
    expect(src).toContain('setBroadcastSelected');
  });

  it('профиль по-прежнему считает контакты без самого себя', () => {
    const src = PROFILE();
    expect(src).toContain('const realContacts = mine ? contacts.filter((c) => c.peerPublicKey !== mine) : contacts;');
    expect(src).toContain('setContactCount(realContacts.length);');
  });
});
