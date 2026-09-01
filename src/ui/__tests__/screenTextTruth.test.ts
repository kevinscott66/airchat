import * as fs from 'fs';
import * as path from 'path';

/**
 * Храповик v4.32.455: текст на экране не обещает того, чего в приложении нет.
 *
 * Дефект этого рода не ломает сборку и не виден тестам логики — он ломает
 * человека. Политика конфиденциальности утверждала «Приложение не запрашивает
 * и не использует данные о геолокации», хотя приложение запрашивает
 * геолокацию в пяти местах и отправляет координаты собеседнику. Пустой список
 * чатов звал «откройте вкладку „Люди“» — вкладки с таким названием нет и
 * никогда не было. Две подсказки про контакты цитировали кнопки, которых на
 * экране не найти.
 *
 * Общее у всех трёх: текст писался один раз и с тех пор жил отдельно от кода,
 * который он описывает. Поэтому тест сверяет не формулировки (их можно и нужно
 * менять), а обещания:
 *
 *   1. чего политика не вправе отрицать, пока код это делает;
 *   2. что «вкладка» в тексте — это вкладка, которая есть в таббаре;
 *   3. что надпись, взятая в „ёлочки“ как маршрут («Профиль» → «Контакты»),
 *      действительно рисуется на своём экране.
 */

const SRC = path.join(__dirname, '..', '..');

/** Все исходники приложения. Тесты — не текст для человека, они не в счёт. */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...collect(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const FILES = collect(SRC);
const SOURCES = FILES.map((f) => fs.readFileSync(f, 'utf8'));
const ALL = SOURCES.join('\n');

/** Файлы, в которых встречается строка. Список короче и понятнее, чем `ALL`. */
function filesWith(needle: string): string[] {
  return FILES.filter((_, i) => SOURCES[i].includes(needle)).map((f) => path.relative(SRC, f));
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Комментарий — не обещание пользователю. */
function codeLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const t = line.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*'));
  });
}

/** Надписи, взятые в ёлочки: «Профиль» → ['Профиль']. Без регулярок. */
function quoted(text: string): string[] {
  const out: string[] = [];
  const parts = text.split('«');
  for (let i = 1; i < parts.length; i++) {
    const end = parts[i].indexOf('»');
    if (end > 0) out.push(parts[i].slice(0, end));
  }
  return out;
}

/** Названия вкладок, названные сразу после слова «вкладка/вкладку/вкладке». */
function tabsNamed(line: string): string[] {
  const out: string[] = [];
  const parts = line.split('вкладк');
  for (let i = 1; i < parts.length; i++) {
    const tail = parts[i];
    const open = tail.indexOf('«');
    const close = tail.indexOf('»');
    if (open < 0 || open > 12 || close <= open) continue;
    out.push(tail.slice(open + 1, close));
  }
  return out;
}

/**
 * Подписи-константы (v4.32.469). Одно и то же действие раньше называлось
 * двумя словами на двух платформах, поэтому такие надписи переехали в
 * ui/clipboardText.ts, а в разметке остался `>{COPY_ID_ACTION}<`. Без развёртки
 * проверка перестала бы находить их текст — и «надпись нарисована» тихо
 * превратилось бы в «мы её не нашли», то есть ровно в ту слепоту, от которой
 * этот храповик и заведён.
 */
const LABEL_CONSTANTS = new Map<string, string>();
for (const line of read('ui/clipboardText.ts').split('\n')) {
  const t = line.trim();
  if (!t.startsWith('export const ')) continue;
  const eq = t.indexOf(" = '");
  const end = t.indexOf("';", eq + 4);
  if (eq < 0 || end < 0) continue;
  LABEL_CONSTANTS.set(t.slice('export const '.length, eq), t.slice(eq + 4, end));
}

/** «{COPY_ID_ACTION}» в тексте — это надпись, лежащая в константе. */
function resolveLabel(label: string): string {
  if (!label.startsWith('{') || !label.endsWith('}')) return label;
  return LABEL_CONSTANTS.get(label.slice(1, -1)) ?? label;
}

/** Надпись нарисована, если её видно в JSX или слышно скринридеру. */
function isRendered(raw: string): boolean {
  const label = resolveLabel(raw);
  const asConstant = [...LABEL_CONSTANTS.entries()]
    .filter(([, value]) => value === label)
    .some(([name]) => ALL.includes('>{' + name + '}<'));
  return (
    asConstant ||
    ALL.includes('>' + label + '<') ||
    ALL.includes('accessibilityLabel="' + label + '"') ||
    ALL.includes('title="' + label + '"')
  );
}

const POLICY = read('ui/screens/PrivacyPolicyScreen.tsx');

describe('политика не отрицает того, что делает код', () => {
  test('раз геолокация запрашивается, политика это признаёт', () => {
    expect(filesWith('Location.requestForegroundPermissionsAsync').length).toBeGreaterThan(0);
    expect(POLICY).not.toContain('не запрашивает и не использует данные о геолокации');
    expect(POLICY).toContain('Геолокация запрашивается только');
  });

  test('«фоновой слежки нет» — обещание, а не оборот речи', () => {
    expect(POLICY).toContain('фоновой слежки нет');
    // Обещание держится ровно до первого фонового доступа к координатам.
    expect(filesWith('requestBackgroundPermissionsAsync')).toEqual([]);
    expect(filesWith('startLocationUpdatesAsync')).toEqual([]);
  });

  test('ретранслятор включён по умолчанию — политика его называет', () => {
    const relay = read('core/transport/internet/relayConfig.ts');
    expect(relay).toContain("DEFAULT_RELAY_BASE = 'https://ntfy.sh'");
    expect(POLICY).toContain('title="Ретранслятор"');
    expect(POLICY).toContain('ntfy.sh');
  });
});

describe('текст не отправляет на вкладку, которой нет', () => {
  /** Таббар — единственный источник списка вкладок. */
  const TABS = read('App.tsx')
    .split('styles.tabActive : styles.tabText}>')
    .slice(1)
    .map((s) => s.slice(0, s.indexOf('<')));

  test('вкладок пять и они названы', () => {
    expect(TABS).toEqual(['Новости', 'Чаты', 'Группы', 'Профиль', 'Ещё']);
  });

  test('каждая названная в тексте вкладка есть в таббаре', () => {
    const bad: string[] = [];
    FILES.forEach((file, i) => {
      for (const line of codeLines(SOURCES[i])) {
        for (const tab of tabsNamed(line)) {
          if (!TABS.includes(tab)) bad.push(path.relative(SRC, file) + ': ' + tab);
        }
      }
    });
    expect(bad).toEqual([]);
  });
});

describe('подсказка-маршрут цитирует существующие надписи', () => {
  /**
   * Подсказка ищется по куску текста, а не по номеру строки: переписать её
   * можно, потерять — нет. Из найденной строки берутся все ёлочки, и каждая
   * обязана быть настоящей надписью интерфейса.
   */
  const HINTS: Array<{ file: string; marker: string }> = [
    { file: 'ui/screens/ChatListScreen.tsx', marker: 'вставьте ID собеседника' },
    { file: 'ui/screens/ContactsScreen.tsx', marker: 'Добавьте первый контакт' },
    { file: 'ui/screens/ContactsScreen.tsx', marker: 'Вставьте его сюда' },
    { file: 'ui/screens/ProfileScreen.tsx', marker: 'Друг может отсканировать код' },
    { file: 'ui/screens/PrivacyPolicyScreen.tsx', marker: 'Вы можете удалить их' },
  ];

  test.each(HINTS)('$file: $marker', ({ file, marker }) => {
    const line = read(file)
      .split('\n')
      .find((l) => l.includes(marker));
    expect(line).toBeDefined();
    const labels = quoted(line ?? '');
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((l) => !isRendered(l))).toEqual([]);
  });
});

describe('проверка не пустая', () => {
  /** Тексты, какими они были до 455-го. */
  const BEFORE = {
    policy: 'Приложение не запрашивает и не использует данные о геолокации.',
    chatList: 'Откройте вкладку «Люди» чтобы найти собеседников',
    // v4.32.469: кнопка теперь подписана «Копировать ID» — в образце стоит
    // текущее её имя, чтобы ненайденной осталась ровно одна надпись,
    // та самая «Найти людей», ради которой образец и заведён.
    contacts: 'Попросите друга: «Профиль» → «Найти людей» → «Копировать ID».',
  };

  test('старая формулировка про геолокацию была бы поймана', () => {
    expect(BEFORE.policy).toContain('не запрашивает и не использует данные о геолокации');
    expect(filesWith(BEFORE.policy)).toEqual([]);
  });

  test('вкладка «Люди» была бы поймана', () => {
    expect(tabsNamed(BEFORE.chatList)).toEqual(['Люди']);
    expect(filesWith(BEFORE.chatList)).toEqual([]);
  });

  test('надпись, которой нет, была бы поймана', () => {
    expect(quoted(BEFORE.contacts).filter((l) => !isRendered(l))).toEqual(['Найти людей']);
  });

  test('надпись из константы видна проверке — и только через константу', () => {
    expect(LABEL_CONSTANTS.get('COPY_ID_ACTION')).toBe('Копировать ID');
    expect(resolveLabel('{COPY_ID_ACTION}')).toBe('Копировать ID');
    expect(resolveLabel('{НЕТ_ТАКОЙ}')).toBe('{НЕТ_ТАКОЙ}');
    // Литерала в разметке больше нет — значит проверка нашла её развёрткой.
    expect(ALL).not.toContain('>Копировать ID<');
    expect(isRendered('Копировать ID')).toBe(true);
    expect(isRendered('{COPY_ID_ACTION}')).toBe(true);
    // Константа, которую нигде не рисуют, нарисованной не считается.
    expect(isRendered('Ссылка скопирована')).toBe(false);
  });
});
