/**
 * Две копии, прожившие под храповиком (v4.32.910).
 *
 * Дефект. В v4.32.425 подпись «кто это, если имени нет» свели к одному
 * правилу — `shortIdentity`, — и поставили храповик (shortIdCallSites),
 * который ищет срез значения с говорящим именем: `did`, `pub`, `key`. Две
 * копии проехали мимо именно потому, что резали значение БЕЗ такого имени:
 *
 *   • чёрный список: `{item.slice(0, 24)}…` — `item` это элемент FlatList;
 *   • добавление контакта: `Контакт ${…toString('base64').slice(0, 6)}` —
 *     режется результат кодирования, у которого имени нет вовсе.
 *
 * Цена. В чёрном списке строка контакта без имени складывалась из ДВУХ РАЗНЫХ
 * сокращений одного ключа: сверху `contactLabel` подставлял `sYk1v0…1qA4E=`,
 * снизу стояло `sYk1v0QpX3nJ7mR2tLc8WbF4…`. Человек видел две непохожие
 * строки и не мог понять, один это ключ или два, — ровно третья беда из
 * докблока `shortId`, ради которой всё и затевалось. Имя по умолчанию давало
 * третью форму: «Контакт sYk1v0» — шесть знаков с одного конца, без
 * многоточия, то есть выглядящих как законченное слово.
 *
 * Правка. Оба места зовут `shortIdentity`. В чёрном списке ключ под именем
 * показывается только тогда, когда сверху стоит настоящее имя: если сверху
 * и так ключ, повторять его незачем.
 *
 * Храповик заодно расширен — новое правило ловит срез по кодированию, а не по
 * имени значения (см. shortIdCallSites, ENCODED_SLICE).
 *
 * Экраны в jest не поднимаются (react-native внутри), поэтому правило
 * проверяется по исходнику — как в ownStoryView672 и storyBlankName906.
 */
import fs from 'fs';
import path from 'path';

import { contactLabel } from '../../core/social/contactLabel';
import { shortIdentity } from '../identity/shortId';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');
/** Только код: пояснения к правке цитируют и старую форму, и новую. */
const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const BLOCKED = 'components/BlockedContactsList.tsx';
const CONTACTS = 'screens/ContactsScreen.tsx';

/** Ключ контакта, чья карточка ещё не приехала. */
const PUB = 'sYk1v0QpX3nJ7mR2tLc8WbF4aZ6hE9uY0oI5dK1qA4E=';

describe('обе копии сокращения сняты', () => {
  it('чёрный список не режет ключ сам', () => {
    const body = codeOnly(BLOCKED);
    expect(body).not.toContain('{item.slice(0, 24)}…');
    expect(body).not.toContain('.slice(0, 24)');
  });

  it('чёрный список берёт обе строки из одного правила', () => {
    const body = codeOnly(BLOCKED);
    expect(body).toContain('const short = shortIdentity(pubB64);');
    expect(body).toContain('const title = contactLabel(c?.displayName, short);');
    expect(body).toContain('return { title, keyLine: title === short ? null : short };');
  });

  it('ключ под именем не показывается, когда сверху и так ключ', () => {
    const body = codeOnly(BLOCKED);
    expect(body).toContain('const { title, keyLine } = rowFor(item);');
    expect(body).toContain('{keyLine ? (');
    expect(body).toContain('{keyLine}');
  });

  it('имя по умолчанию собирается тем же правилом', () => {
    const body = codeOnly(CONTACTS);
    expect(body).not.toContain("toString('base64').slice(0, 6)");
    expect(body).toContain(
      "`Контакт ${shortIdentity(Buffer.from(parsedKey).toString('base64'))}`",
    );
  });

  it('храповик теперь ловит срез по кодированию', () => {
    const ratchet = read('__tests__/shortIdCallSites.test.ts');
    expect(ratchet).toContain('const ENCODED_SLICE =');
    expect(ratchet).toContain('экранный слой не режет и только что закодированный ключ');
  });
});

describe('до правки было верно и осталось верно', () => {
  it('обе формы, которые теперь совпадают, раньше не совпадали', () => {
    // Цена дефекта, зафиксированная значением: так выглядела строка чёрного
    // списка у контакта без имени — сверху одно, снизу другое.
    const wasTop = contactLabel('', shortIdentity(PUB));
    const wasBottom = `${PUB.slice(0, 24)}…`;
    expect(wasTop).toBe('sYk1v0…1qA4E=');
    expect(wasBottom).toBe('sYk1v0QpX3nJ7mR2tLc8WbF4…');
    expect(wasTop).not.toBe(wasBottom);
    // И третья форма — имя по умолчанию при добавлении.
    expect(`Контакт ${PUB.slice(0, 6)}`).toBe('Контакт sYk1v0');
  });

  it('у контакта с именем ключ под ним по-прежнему нужен и виден', () => {
    const short = shortIdentity(PUB);
    const title = contactLabel('Аня', short);
    expect(title).toBe('Аня');
    expect(title === short ? null : short).toBe('sYk1v0…1qA4E=');
  });

  it('у контакта без имени вторая строка была бы повтором первой', () => {
    const short = shortIdentity(PUB);
    const title = contactLabel('', short);
    expect(title).toBe(short);
    expect(title === short ? null : short).toBeNull();
  });

  it('чёрный список по-прежнему объясняет непрочитанный список', () => {
    const body = codeOnly(BLOCKED);
    expect(body).toContain('blocked_list_unreadable');
    expect(body).toContain('Список заблокированных не прочитался.');
    expect(body).toContain('blocked_list_empty');
  });

  it('разблокировка по-прежнему проверяет, легла ли запись', () => {
    expect(codeOnly(BLOCKED)).toContain(
      "if (!(await rateLimiter.unblockContact(item))) Alert.alert('AirChat', BLOCK_NOT_SAVED_OFF);",
    );
  });

  it('введённое имя по-прежнему сильнее собранного', () => {
    expect(codeOnly(CONTACTS)).toContain('addNameInput.trim() ||');
  });
});
