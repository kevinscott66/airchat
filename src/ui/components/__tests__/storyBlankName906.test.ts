/**
 * Безымянный контакт подписан пустотой (v4.32.906).
 *
 * Дефект. `StoriesRow` брал имя из карты контактов через `??`:
 *
 *     nameMap?.[story.authorPubB64] ?? shortIdentity(story.authorPubB64)
 *     nameMap.get(pub) ?? shortIdentity(pub)
 *     const name = nameMap?.[v]; return name ?? `${v.slice(0, 10)}…`;
 *
 * Карта строится как `c.displayName ?? ''`, а `Contact.displayName` по типу
 * `string`, и у контакта, чья карточка ещё не приехала, он равен ПУСТОЙ
 * СТРОКЕ: `listContacts` собирает его как `displayName || peerName`, оба
 * пустые. `??` подставляет запасное значение только вместо `null` и
 * `undefined` — то есть не подставляло ни разу. Ровно та ошибка, ради которой
 * написан `contactLabel` (v4.32.372), и в этом файле он уже импортирован —
 * `nameInitial` из него берут строкой выше.
 *
 * Цена. Человек, с которым переписка есть, а имени ещё нет, выложил сторис:
 *   • в кружке ряда сторис рисуется «?» — `nameInitial('')`;
 *   • подпись под кружком пропадает совсем — `''.split(' ')[0]` пуст;
 *   • в шапке открытой сторис вместо автора пустое место;
 *   • в списке «кто посмотрел» его строка — пустая, и счётчик «Просмотрело 3»
 *     расходится с тем, что видно глазами.
 *
 * Третья строка вдобавок брала свою форму сокращения — голову в десять
 * знаков, — тогда как шапка той же сторис показывает `shortIdentity`. Один
 * человек в двух местах одного экрана подписан непересекающимися кусками:
 * ровно третья беда из докблока `shortId`.
 *
 * Правка. Все три чтения идут через `contactLabel(имя, shortIdentity(ключ))`.
 *
 * `StoriesRow.tsx` в jest не поднимается (весь react-native внутри), поэтому
 * правило проверяется по исходнику — как в ownStoryView672.
 */
import fs from 'fs';
import path from 'path';
import { contactLabel, nameInitial } from '../../../core/social/contactLabel';
import { shortIdentity } from '../../identity/shortId';

const ROW = (): string =>
  fs.readFileSync(path.join(__dirname, '..', 'StoriesRow.tsx'), 'utf8');

/**
 * Исходник без строк-комментариев: русское пояснение к правке цитирует те же
 * выражения, что и код, и подсчёт по целому файлу ловил бы их тоже.
 */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');
}

/** Ключ контакта, чья карточка ещё не приехала: имя есть по типу, но пустое. */
const PUB = 'sYk1v0QpX3nJ7mR2tLc8WbF4aZ6hE9uY0oI5dK1qA4E=';

describe('пустое имя контакта больше не доходит до экрана', () => {
  test('шапка сторис берёт имя правилом дома, а не ??', () => {
    const code = codeOnly(ROW());
    expect(code).toContain("{isOwn ? 'Моя сторис' : contactLabel(");
    expect(code).toContain(
      "contactLabel(nameMap?.[story.authorPubB64], shortIdentity(story.authorPubB64))",
    );
    expect(code).not.toContain('nameMap?.[story.authorPubB64] ?? shortIdentity');
  });

  test('подпись кружка в ряду сторис — тем же правилом', () => {
    const code = codeOnly(ROW());
    expect(code).toContain('displayName: contactLabel(nameMap.get(pub), shortIdentity(pub)),');
    expect(code).not.toContain('nameMap.get(pub) ?? shortIdentity(pub)');
  });

  test('список посмотревших — тем же правилом и той же формой сокращения', () => {
    const code = codeOnly(ROW());
    expect(code).toContain('viewers.map((v) => contactLabel(nameMap?.[v], shortIdentity(v)))');
    expect(code).not.toContain('const name = nameMap?.[v];');
    expect(code).not.toContain('return name ?? `${v.slice(0, 10)}…`;');
  });

  test('своей формы сокращения в файле не осталось', () => {
    // Голова в десять знаков была здесь единственным местом, где подпись
    // личности собиралась руками мимо shortIdentity.
    expect(codeOnly(ROW())).not.toContain('.slice(0, 10)');
  });

  test('contactLabel в файле импортирован, а не дописан по месту', () => {
    expect(ROW()).toContain(
      "import { contactLabel, nameInitial } from '../../core/social/contactLabel';",
    );
  });

});

describe('до правки было верно и осталось верно', () => {
  test('на пустом имени contactLabel подставляет сокращённый ключ', () => {
    // Значение, ради которого правка. Само по себе оно было верно и раньше —
    // до экрана просто не доходило.
    expect(contactLabel('', shortIdentity(PUB))).toBe('sYk1v0…1qA4E=');
    expect(contactLabel('', shortIdentity(PUB))).not.toBe('');
  });

  test('пустое имя обнуляет и букву в кружке, и подпись под ним', () => {
    // Цена дефекта, зафиксированная числом: так вело себя прежнее выражение,
    // и так же поведёт себя любое следующее, если снова пропустит пустоту.
    const wasEmpty = '' as string;
    expect(nameInitial(wasEmpty)).toBe('?');
    expect(wasEmpty.split(' ')[0]).toBe('');
    // А так ведёт себя новое.
    const now = contactLabel('', shortIdentity(PUB));
    expect(nameInitial(now)).toBe('S');
    expect(now.split(' ')[0]).toBe(now);
  });

  test('два безымянных контакта различимы между собой', () => {
    const a = contactLabel('', shortIdentity(`${PUB}aaaa`));
    const b = contactLabel('', shortIdentity(`${PUB}bbbb`));
    expect(a).not.toBe(b);
  });
  test('настоящее имя по-прежнему сильнее сокращённого ключа', () => {
    expect(contactLabel('Аня', shortIdentity(PUB))).toBe('Аня');
  });

  test('«Моя сторис» и «Я» остались собственными подписями', () => {
    // Правило дома касается чужих имён: свои подписи заданы на месте и через
    // карту контактов не проходят.
    const code = codeOnly(ROW());
    expect(code).toContain("nameMap.set(myPubB64, 'Я');");
    expect(code).toContain("displayName: 'Я' }");
  });

  test('карта имён по-прежнему строится по peerPublicKey', () => {
    expect(codeOnly(ROW())).toContain(
      'contacts.map((c) => [c.peerPublicKey, c.displayName ?? ""])'.replace(/"/g, "'"),
    );
  });

  test('пустой список посмотревших по-прежнему говорит «Нет данных»', () => {
    expect(codeOnly(ROW())).toContain("|| 'Нет данных',");
  });

  test('shortIdentity по-прежнему снимает did:key: и режет поровну', () => {
    expect(shortIdentity('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')).toBe(
      'z6Mkha…ta2doK',
    );
  });
});
