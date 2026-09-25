/**
 * У строки личности было три названия (v4.32.914).
 *
 * Дефект. Одну и ту же строку — ту, которой человек представляется и которую
 * вставляют, чтобы его добавить, — приложение называло тремя словами:
 *
 *     свой профиль        «Ваш адрес для связи», «…не набирая адрес»
 *     вход в аккаунт      «Ваш адрес: z6MkhaXgBZDvotDk…»
 *     отказ о дубликате   «Один и тот же адрес нельзя добавить дважды»
 *     карточка чужого     «DID»
 *     всё остальное       «ID» — «Копировать ID», «ID скопирован» (v4.32.469),
 *                         «Это ваш собственный ID», «Ссылка или ID контакта»
 *                         (v4.32.911), озвучка «Поделиться ID»
 *
 * Цена. Разрыв проходит ровно по передаче строки из рук в руки. Пустой список
 * контактов посылает человека словами «попросите друга открыть «Профиль» →
 * «Мой QR-код», отсканируйте код или вставьте его ID» — а на том экране, куда
 * он послан, слова «ID» не было ни одного: там «адрес». В карточке чужого
 * профиля подпись «DID» — слово протокола, которое на экране не значит ничего,
 * и стоит оно в двух сантиметрах от кнопки, озвученной как «Поделиться ID».
 *
 * Правка. Одно слово — «ID». «Адрес» остаётся за группой: её публичный адрес
 * это другая вещь, и она действительно адрес.
 *
 * Экраны в jest не поднимаются (весь react-native внутри), поэтому надписи
 * проверяются по исходнику — как в storyBlankName906.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { COPIED_ID, COPY_ID_ACTION } from '../clipboardText';
import { CONTACT_ID_UNPARSED_TEXT } from '../commonText';

const UI = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(UI, rel), 'utf8');

/** Исходник без комментариев: пояснение к правке цитирует прежние надписи. */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

describe('строку личности везде зовут одним словом', () => {
  test('свой профиль подписывает её как ID', () => {
    const code = codeOnly(read('screens/ProfileScreen.tsx'));
    expect(code).toContain('<Text style={styles.userIdLabel}>Ваш ID</Text>');
    expect(code).not.toContain('Ваш адрес для связи');
    expect(code).toContain('друг добавит вас, не набирая ID вручную.');
    expect(code).not.toContain('не набирая адрес.');
  });

  test('экран входа — тем же словом', () => {
    const code = codeOnly(read('screens/LoginScreen.tsx'));
    expect(code).toContain('Ваш ID: {shortIdentity(did, 20)}');
    expect(code).not.toContain('Ваш адрес:');
  });

  test('отказ о дубликате — тем же словом', () => {
    const code = codeOnly(read('screens/ContactsScreen.tsx'));
    expect(code).toContain('Один и тот же ID нельзя добавить дважды.');
    expect(code).not.toContain('Один и тот же адрес нельзя добавить дважды');
  });

  test('карточка чужого профиля больше не показывает слово протокола', () => {
    const code = codeOnly(read('components/UserProfilePeek.tsx'));
    expect(code).toContain('>ID</Text>');
    expect(code).not.toContain('>DID</Text>');
  });

  test('слова протокола не осталось ни в одной надписи экранного слоя', () => {
    // Храповик. Ищется именно НАДПИСЬ: `did:key:`, имена переменных и стили
    // (`didLabel`, `shortDid`) — это код, и трогать их незачем.
    const offenders: string[] = [];
    for (const rel of ['components/UserProfilePeek.tsx', 'screens/ProfileScreen.tsx', 'screens/LoginScreen.tsx']) {
      for (const line of codeOnly(read(rel)).split('\n')) {
        if (/>\s*DID\s*</.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('до правки было верно и осталось верно', () => {
  test('дом и раньше звал эту строку ID — к нему и сведено', () => {
    expect(COPY_ID_ACTION).toBe('Копировать ID');
    expect(COPIED_ID).toBe('ID скопирован');
    expect(CONTACT_ID_UNPARSED_TEXT).toContain('ссылку или ID AirChat');
  });

  test('пустой список контактов посылал за «ID» — теперь есть куда', () => {
    const contacts = codeOnly(read('screens/ContactsScreen.tsx'));
    expect(contacts).toContain('«Мой QR-код», отсканируйте код или вставьте его ID');
    expect(contacts).toContain('Ссылка или ID контакта');
    expect(contacts).toContain("'Это ваш собственный ID — нельзя добавить самого себя как контакт.'");
  });

  test('озвучка кнопок рядом с подписью не менялась', () => {
    const peek = codeOnly(read('components/UserProfilePeek.tsx'));
    expect(peek).toContain('accessibilityLabel="Поделиться ID"');
    expect(peek).toContain('accessibilityLabel="Показать QR-код"');
  });

  test('публичный адрес группы остался адресом', () => {
    // Это другая вещь: ссылка, по которой группу находят, а не подпись
    // человека. Сводить их одним словом было бы враньём.
    const groups = codeOnly(read('screens/GroupsScreen.tsx'));
    expect(groups).toContain("'Публичный адрес обновлён'");
    expect(groups).toContain("showError('Не удалось сохранить публичный адрес');");
  });

  test('сокращение самой строки не трогали — менялась только подпись к ней', () => {
    expect(codeOnly(read('screens/LoginScreen.tsx'))).toContain('shortIdentity(did, 20)');
    expect(codeOnly(read('components/UserProfilePeek.tsx'))).toContain('shortDid(resolved.did, 10)');
  });

  test('обход исходника не пуст и комментарии из него убраны', () => {
    // Невырожденность: без этого проверки на отсутствие зелены и на пустой строке.
    for (const rel of ['screens/ProfileScreen.tsx', 'components/UserProfilePeek.tsx']) {
      expect(read(rel).length).toBeGreaterThan(10_000);
    }
    expect(codeOnly('// Ваш адрес для связи\nconst a = 1;')).not.toContain('адрес');
    expect(codeOnly('{/* Ваш адрес */}\nconst a = 1;')).not.toContain('адрес');
    expect(codeOnly('const t = "Ваш адрес для связи";')).toContain('адрес');
  });
});
