/**
 * «Код» на одном экране означал две разные вещи (v4.32.911).
 *
 * Дефект. В списке контактов пустое состояние просит: «попросите друга
 * открыть «Профиль» → «Мой QR-код», отсканируйте код или вставьте его ID» —
 * здесь «код» это картинка. Кнопка «Добавить контакт» под этой же надписью
 * открывает окно, где поле подписано «Ссылка или код контакта», а прямо под
 * полем стоит кнопка «Сканировать QR» — и здесь «код» это уже строка. То же
 * слово в том же смысле «то, что прислал друг», но в одном случае его
 * сканируют, а в другом вставляют.
 *
 * Цена. Человек, прочитавший «Ссылка или код», ищет код — то есть картинку
 * или камеру, — и кнопка «Сканировать QR» рядом эту догадку подтверждает.
 * Строку, которую ему прислали текстом, он в это поле не несёт, потому что
 * «кодом» её нигде больше не называли: в доме она ID — «Копировать ID», «ID
 * скопирован» (v4.32.469), «Это ваш собственный ID».
 *
 * Правка. «Код» остаётся за QR; строка везде зовётся ID. Заодно текст ошибки
 * разбора, стоявший слово в слово в двух экранах, переехал в общий файл:
 * править две копии одной надписи и значит получить расхождение.
 *
 * Экраны в jest не поднимаются (весь react-native внутри), поэтому надписи
 * проверяются по исходнику — как в storyBlankName906.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { CONTACT_ID_UNPARSED_TEXT, CONTACT_KEY_BROKEN_TEXT, NOT_READY_TEXT } from '../commonText';

const UI = join(__dirname, '..');

const read = (rel: string): string => readFileSync(join(UI, rel), 'utf8');

/**
 * Исходник без комментариев: пояснение к правке цитирует прежние надписи, и
 * подсчёт по целому файлу ловил бы их наравне с кодом.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const UI_FILES = collect(UI).map((full) => ({
  key: full.slice(UI.length + 1).split('\\').join('/'),
  code: codeOnly(readFileSync(full, 'utf8')),
}));

describe('строку, которую вставляют, зовут ID, а кодом остаётся QR', () => {
  test('поле в списке контактов подписано ID', () => {
    const code = codeOnly(read('screens/ContactsScreen.tsx'));
    expect(code).toContain('<Text style={styles.label}>Ссылка или ID контакта</Text>');
    expect(code).not.toContain('Ссылка или код контакта');
  });

  test('поле в окне нового чата подписано ID', () => {
    const code = codeOnly(read('screens/ChatListScreen.tsx'));
    expect(code).toContain('Ссылка или ID собеседника</Text>');
    expect(code).not.toContain('Ссылка или код собеседника');
  });

  test('просьба вставить — тоже про ID', () => {
    const code = codeOnly(read('screens/ChatListScreen.tsx'));
    expect(code).toContain("'Вставьте ссылку или ID собеседника'");
    expect(code).not.toContain('Вставьте ссылку или код собеседника');
  });

  test('текст ошибки разбора живёт в одном месте и говорит ID', () => {
    expect(CONTACT_ID_UNPARSED_TEXT).toBe(
      'Это не похоже на ссылку или ID AirChat. Попросите прислать их заново.',
    );
    for (const rel of ['screens/ContactsScreen.tsx', 'screens/ChatListScreen.tsx']) {
      const code = codeOnly(read(rel));
      expect(code).toContain('CONTACT_ID_UNPARSED_TEXT');
      expect(code).toContain("from '../commonText'");
      expect(code).not.toContain('Это не похоже на ссылку или код AirChat');
      // Копии больше нет: надпись зовут по имени, а не пишут заново.
      expect(code).not.toContain('Это не похоже на ссылку или ID AirChat');
    }
  });

  test('во всём экранном слое «или код» не осталось', () => {
    // Храповик: следующее поле для того же значения нельзя будет подписать
    // прежним словом, не уронив эту проверку.
    const offenders = UI_FILES.filter((f) => f.code.includes('или код')).map((f) => f.key);
    expect(offenders).toEqual([]);
  });
});

describe('до правки было верно и осталось верно', () => {
  test('QR по-прежнему зовут кодом — менялось не это', () => {
    const contacts = codeOnly(read('screens/ContactsScreen.tsx'));
    expect(contacts).toContain('«Мой QR-код», отсканируйте код или вставьте его ID');
    expect(contacts).toContain('<Text style={styles.pasteBtnText}>Сканировать QR</Text>');
  });

  test('в пустом состоянии присланная строка и раньше звалась ID', () => {
    // Именно из-за этого расхождение и заметно: два названия одного и того же
    // стоят в четырёх строках друг от друга.
    expect(codeOnly(read('screens/ContactsScreen.tsx'))).toContain('вставьте его ID');
  });

  test('«свой ID» в проверке на себя не трогали', () => {
    expect(codeOnly(read('screens/ContactsScreen.tsx'))).toContain(
      "'Это ваш собственный ID — нельзя добавить самого себя как контакт.'",
    );
  });

  test('подсказка в самом поле осталась прежней', () => {
    for (const rel of ['screens/ContactsScreen.tsx', 'screens/ChatListScreen.tsx']) {
      expect(codeOnly(read(rel))).toContain('placeholder="Вставьте то, что вам прислали"');
    }
  });

  test('соседи по общему файлу на месте', () => {
    expect(NOT_READY_TEXT).toBe('Приложение ещё запускается — попробуйте через пару секунд');
    expect(CONTACT_KEY_BROKEN_TEXT).toBe(
      'Запись этого контакта повреждена. Добавьте его заново по ссылке',
    );
  });

  test('обход экранного слоя не пуст и комментарии из него убраны', () => {
    // Невырожденность: без этого сквозная проверка зелена и на пустом списке.
    expect(UI_FILES.length).toBeGreaterThan(100);
    expect(UI_FILES.map((f) => f.key)).toContain('commonText.ts');
    expect(codeOnly('// ссылка или код\nconst a = 1;')).not.toContain('или код');
    expect(codeOnly('/* ссылка или код */\nconst a = 1;')).not.toContain('или код');
    expect(codeOnly('{/* ссылка или код */}\nconst a = 1;')).not.toContain('или код');
    expect(codeOnly("const t = 'ссылка или код';")).toContain('или код');
  });

  test('PIN-код словом «код» зовётся законно и под правило не попадает', () => {
    // Правило запрещает только «или код» — пароль устройства это другое слово
    // в другом месте, и переименовывать его было бы враньём.
    expect(codeOnly('const t = "Введите код доступа";')).not.toContain('или код');
  });
});
