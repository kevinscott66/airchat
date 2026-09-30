/**
 * ДЕФЕКТ. Экран «Контакты» отличал сбой чтения от пустоты (v4.32.622) и
 * называл беду всплывашкой — но только ею. Под всплывашкой оставался прежний
 * экран, а при первом чтении прежнее — это пустой список: во весь экран
 * «Пока никого в списке», текст «Добавьте первый контакт» и кнопка рядом.
 * Всплывашка уходит через секунды, надпись остаётся до следующего чтения.
 *
 * Вторая половина того же дефекта — в окне добавления. Проверка на дубликат
 * шла по списку в состоянии экрана, а он при сбое пуст. Дубликат «не
 * находился», и addContact дальше ставил displayName из патча — непустого
 * здесь всегда («Контакт xxx», если поле пустое). Человек, повторно
 * вставивший знакомый ID, вместо «Контакт уже добавлен» получал
 * переименованный контакт. Это ровно то «фантомное повторное добавление»,
 * против которого проверку и завели в v4.32.44; в окне списка чатов ту же
 * дыру закрыли в v4.32.999, а главный экран контактов тогда пропустили.
 *
 * ЦЕНА. Записная книжка пропала на вид, и экран сам зовёт завести её заново.
 * Заведённый заново контакт — это новая запись без имени, без привязок и без
 * истории; а если исходная всё-таки прочиталась, ей ещё и сменится имя.
 *
 * ПРАВКА. Сбой чтения поднимает отдельное состояние, и вместо приглашения
 * показывается общая пометка UNREADABLE_CONTACTS_TEXT с подсказкой потянуть
 * список. Окно добавления перечитывает книгу честной парой listContactsRead
 * и на отказе не добавляет ничего.
 *
 * ГРАНИЦЫ. Честно пустая книга показывает приглашение как прежде. Удачное
 * чтение снимает состояние. Пометка берётся из общего места, а не пишется
 * заново: расходиться таким словам нельзя.
 */
import fs from 'fs';
import path from 'path';
import { UNREADABLE_CONTACTS_TEXT } from '../../../core/storage/unreadableText';

const root = path.resolve(__dirname, '../../../..');
const SCREEN = (): string =>
  fs.readFileSync(path.join(root, 'src/ui/screens/ContactsScreen.tsx'), 'utf8');

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
  const b = src.indexOf(to, a + from.length);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

/** Тело загрузчика списка. */
const loader = (): string =>
  slice(codeOnly(SCREEN()), 'const load = useCallback(async () => {', '}, [myPubB64]);');

/** Подпись вместо списка. */
const empty = (): string =>
  slice(codeOnly(SCREEN()), 'ListEmptyComponent={', '<Modal\n        visible={addVisible}');

/** Тело отправки формы добавления. */
const submit = (): string =>
  slice(codeOnly(SCREEN()), 'const submitAdd = useCallback(async () => {', 'const shareMyId = useCallback(');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('экран прочитан, и куски вырезаны не пустыми', () => {
    expect(SCREEN().length).toBeGreaterThan(20000);
    expect(loader().length).toBeGreaterThan(300);
    expect(empty().length).toBeGreaterThan(300);
    expect(submit().length).toBeGreaterThan(1000);
  });

  it('загрузчик по-прежнему различает пустоту и сбой', () => {
    const body = loader();
    expect(body).toContain('const detailed = await listContactsReadDetailed();');
    expect(body).toContain('if (!shouldApplyRows(read)) {');
    expect(body).toContain('Не удалось прочитать контакты');
  });

  it('добавление по-прежнему заканчивается вызовом addContact', () => {
    expect(submit()).toContain('await addContact(pair, parsedKey, name);');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('приглашение завести первый контакт никуда не делось', () => {
    const body = empty();
    expect(body).toContain('Пока никого в списке');
    expect(body).toContain('Добавьте первый контакт');
    expect(body).toContain('testID="contacts_empty_add"');
  });

  it('подсказка о дубликате в окне по-прежнему считается на экране', () => {
    // Строка под полем ввода живёт от isDuplicate — её правка не трогает.
    expect(codeOnly(SCREEN())).toContain('const isDuplicate = useMemo(() => {');
    expect(codeOnly(SCREEN())).toContain('{isDuplicate ? (');
  });

  it('отказ чтения по-прежнему выходит из загрузчика, ничего не подставляя', () => {
    const body = loader();
    const guard = body.indexOf('if (!shouldApplyRows(read)) {');
    const apply = body.indexOf('setContacts(filtered);');
    expect(guard).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(guard);
    expect(slice(body, 'if (!shouldApplyRows(read)) {', 'setContacts(filtered);')).toContain('return;');
  });
});

describe('форма правки', () => {
  it('сбой чтения книги стал отдельным состоянием экрана', () => {
    expect(codeOnly(SCREEN())).toContain(
      'const [contactsReadFailed, setContactsReadFailed] = useState(false);'
    );
  });

  it('слово о непрочитанной книге берётся из общего места', () => {
    const src = SCREEN();
    expect(src).toContain(
      "import { UNREADABLE_CONTACTS_TEXT } from '../../core/storage/unreadableText';"
    );
    // Своя копия текста разошлась бы с остальными экранами молча.
    expect(src).not.toContain("'Контакты не удалось прочитать'");
  });

  it('окно добавления читает книгу честной парой', () => {
    expect(SCREEN()).toContain('  listContactsRead,\n');
    expect(submit()).toContain('const known = await listContactsRead();');
  });
});

describe('непрочитанная книга больше не выдаётся за пустую', () => {
  it('подпись вместо списка выбирается по исходу чтения', () => {
    const body = empty();
    expect(body).toContain('contactsReadFailed ? (');
    expect(body.indexOf('contactsReadFailed ? (')).toBeLessThan(body.indexOf('Пока никого в списке'));
  });

  it('в ветке отказа нет ни приглашения, ни кнопки «добавить»', () => {
    const failed = slice(empty(), 'contactsReadFailed ? (', ') : (');
    expect(failed).toContain('UNREADABLE_CONTACTS_TEXT');
    expect(failed).toContain('Потяните список вниз');
    expect(failed).not.toContain('Пока никого в списке');
    expect(failed).not.toContain('Добавьте первый контакт');
    expect(failed).not.toContain('contacts_empty_add');
  });

  it('в ветке пустоты приглашение осталось целиком', () => {
    const invite = empty().slice(empty().indexOf(') : ('));
    expect(invite).toContain('Пока никого в списке');
    expect(invite).toContain('Добавьте первый контакт');
    expect(invite).toContain('testID="contacts_empty_add"');
    expect(invite).not.toContain('UNREADABLE_CONTACTS_TEXT');
  });

  it('состояние поднимается на отказе и снимается на удачном чтении', () => {
    const body = loader();
    const fail = slice(body, 'if (!shouldApplyRows(read)) {', 'setContacts(filtered);');
    expect(fail).toContain('setContactsReadFailed(true);');
    expect(fail).toContain('setContactsReadFailed(false);');
    // Снятие стоит ПОСЛЕ выхода: иначе отказ снимал бы собственную пометку.
    expect(fail.indexOf('setContactsReadFailed(true);')).toBeLessThan(fail.indexOf('return;'));
    expect(fail.indexOf('return;')).toBeLessThan(fail.indexOf('setContactsReadFailed(false);'));
  });
});

describe('окно добавления не заводит второй контакт вслепую', () => {
  it('отказ чтения прекращает добавление до вызова addContact', () => {
    const body = submit();
    const refusal = body.indexOf('if (known === null) {');
    const add = body.indexOf('await addContact(pair, parsedKey, name);');
    expect(refusal).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(refusal);
    expect(slice(body, 'if (known === null) {', 'await addContact(')).toContain('return;');
  });

  it('отказ объясняет, почему не добавили, а не просто жалуется', () => {
    const refusal = slice(submit(), 'if (known === null) {', 'const duplicate');
    expect(refusal).toContain('UNREADABLE_CONTACTS_TEXT');
    expect(refusal).toContain('сменилось бы имя');
  });

  it('дубликат ищется в свежепрочитанном списке, а не в состоянии экрана', () => {
    const body = submit();
    expect(body).toContain('const duplicate = parsedB64 ? known.find((c) => c.peerPublicKey === parsedB64) ?? null : null;');
    expect(body).toContain('if (duplicate) {');
    expect(body).not.toContain('const dup = isDuplicate;');
    expect(body).not.toContain('if (isDuplicate) {');
  });

  it('список зависимостей обновлён вместе с чтением', () => {
    const deps = slice(codeOnly(SCREEN()), '  }, [parsedKey,', ']);');
    expect(deps).toContain('parsedB64');
    expect(deps).not.toContain('isDuplicate');
  });
});

describe('ГРАНИЦА', () => {
  it('общая пометка осталась той же строкой', () => {
    expect(UNREADABLE_CONTACTS_TEXT).toBe('Контакты не удалось прочитать');
    // Не «контакт»: речь обо всей книге, а не об одной записи.
    expect(UNREADABLE_CONTACTS_TEXT).not.toContain('Контакт ');
  });

  it('частично прочитанная книга по-прежнему считается отдельно', () => {
    const body = loader();
    expect(body).toContain('if (detailed && detailed.missing > 0) {');
    expect(body).toContain('они на месте, но в списке их нет');
  });

  it('непрочитанный блок-лист остался своим состоянием', () => {
    const src = codeOnly(SCREEN());
    expect(src).toContain('const [blockUnknown, setBlockUnknown] = useState(false);');
    expect(src).toContain('setBlockUnknown(!readable);');
  });
});
