/**
 * Храповик на цвета, вписанные руками.
 *
 * Раунды 344–396 разбирали один и тот же дефект по одному экземпляру за раз:
 * цвет, написанный литералом, не подчиняется ни теме, ни выбранному акценту и
 * не виден контрастному тесту. Каждый раз это находилось глазами — то есть
 * находилось не всё и не сразу: галочки в пузыре прожили так двенадцать
 * версий, счётчик реакций — весь срок жизни светлой темы.
 *
 * Этот тест не чинит остаток (он большой и разбирается по частям), а не даёт
 * ему расти: у каждого файла записано, сколько литералов в нём было на момент
 * 397-го. Больше — тест падает. Меньше — тоже падает, но с просьбой опустить
 * планку: иначе исправленное место молча освободит квоту под новое.
 *
 * Файл, которого в списке нет, не может завести литерал вовсе.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/** Корень исходников относительно этого теста. */
const SRC = join(__dirname, '..', '..');

/**
 * Файлы, где литерал — не цвет интерфейса и палитре не подчиняется.
 *
 * Каждое исключение здесь названо с причиной. Молчаливых исключений быть не
 * должно: список исключений, который никто не может прочесть, — это отключённый
 * тест.
 */
const EXEMPT: Record<string, string> = {
  // Цвет ярлыка папки — ДАННЫЕ: его выбирает пользователь и хранит база.
  'core/storage/chatFolders.ts': 'пользовательский цвет папки, не тема',
  // Обои чата — тот же случай: набор фонов, из которого выбирает пользователь.
  // Правило «что читается поверх них» лежит в том же файле и под тестом.
  'ui/wallpapers.ts': 'набор обоев чата, выбор пользователя',
  // Заставка живёт снаружи ThemeProvider и намеренно всегда тёмная (@stable).
  'ui/components/SplashOverlay.tsx': 'экран до инициализации темы, @stable',
  // Сама палитра.
  'ui/theme.ts': 'палитра и есть источник значений',
};

/**
 * Сколько литералов было в файле на момент 397-го. Список может только
 * укорачиваться.
 */
const BASELINE: Record<string, number> = {
  // v4.32.419: список опустел. Восемнадцать последних строк были одним и тем
  // же правилом в восемнадцати копиях — «белым по кнопке» — и три уехали на
  // плёнку `mediaScrim`, под которой они и лежали. Пустая запись здесь не
  // формальность: любой новый вписанный цвет теперь падает сразу, без
  // разбирательства, «был он тут раньше или нет».
};
/** Все .ts/.tsx под src, кроме тестов. */
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

/** Строки файла без комментариев — общая основа обеих проверок. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    // '{/*' — комментарий внутри JSX; без него разбор считал за литерал
    // объяснение, ПОЧЕМУ литерал убрали (v4.32.399).
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

/**
 * Литералы цвета в файле — только в коде, не в комментариях.
 *
 * Тень исключена намеренно: `shadowColor: '#000'` — не цвет палитры, а
 * непрозрачность, заданная отдельным полем, и в светлой теме тень тоже чёрная.
 */
function literalsIn(source: string): string[] {
  const found: string[] = [];
  for (const line of codeLines(source)) {
    if (line.includes('shadowColor')) continue;
    const matches = line.match(/['"]#[0-9a-fA-F]{3,8}['"]/g);
    if (matches) found.push(...matches);
  }
  return found;
}

/**
 * Склейка цвета с прозрачностью на месте вызова — `colors.primary + '22'`.
 *
 * Храповик выше её не видит: восьмизначного литерала в исходнике нет, он
 * собирается во время работы. А результат непрозрачным цветом не является:
 * `parseHex` его не разбирает, `contrastRatio` отвечает 1, и контрастный тест
 * молча пропускает место, которое сам же и должен был проверить (v4.32.407).
 * Раунды 407–409 разобрали все сорок с лишним таких мест; эта проверка не даёт
 * форме вернуться.
 *
 * v4.32.416: две склейки её пережили — и обе не по причине, а по форме записи.
 * Осциллограмма ставила между плюсом и кавычкой тернар
 * (`colors.error + (свежий ? 'ff' : 'aa')`), а полоска состояния прятала
 * прозрачность в именованную константу (`ink + BORDER_ALPHA_HEX`), и кавычки
 * за плюсом не было вовсе. Прежнее выражение искало кавычку вплотную к плюсу,
 * то есть проверяло не дефект, а его самую наивную запись. Теперь ищется вся
 * правая часть сложения до конца выражения, и отдельно — сама константа: имя с
 * ALPHA или OPACITY, которому присвоены две шестнадцатеричные цифры строкой.
 */
function alphaMixesIn(source: string): string[] {
  const found: string[] = [];
  for (const line of codeLines(source)) {
    const glued = line.match(/[A-Za-z0-9_\])]\s*\+\s*\(?[^+;]*?['"][0-9a-fA-F]{2}['"]/g);
    if (glued) found.push(...glued);
    const hidden = line.match(/\b\w*(?:ALPHA|OPACITY|Alpha|Opacity)\w*\s*=\s*['"][0-9a-fA-F]{2}['"]/g);
    if (hidden) found.push(...hidden);
  }
  return found;
}

/**
 * Где склейка с прозрачностью разрешена. Как и `EXEMPT`, только с причиной.
 */
const RGBA_EXEMPT: Record<string, string> = {
  // Сама палитра: волна нажатия и полоса поверх кадра заданы здесь и здесь же
  // проверены.
  'ui/theme.ts': 'палитра и есть источник значений',
};

/**
 * Сколько записей `rgba(...)` было в файле на момент 411-го.
 *
 * Третья форма того же дефекта. Хекс-храповик её не видит: литерала `#` в
 * строке нет. Между тем `rgba(255, 255, 255, 0.7)` — не цвет, а обещание, что
 * под ним темно; `contrastRatio` его не разбирает и молча отвечает 1, ровно
 * как на склейке с прозрачностью. Замерено в 411-м: в светлой теме такой белый
 * даёт на исходящем пузыре 3.40:1 при пороге 4.5, а в групповом — 2.84:1.
 *
 * Список сидит здесь целиком, чтобы популяция перестала быть невидимой.
 *
 * v4.32.412 забрал из него плёнки: затемнение под окном ушло в `scrim.modal`,
 * плашки поверх чужого кадра — в `mediaScrim.bar`. Было 46 файлов и 105
 * записей, стало 8 и 41; все 35 модальных окон обнулились.
 *
 * v4.32.413 забрал содержимое пузырей, которое рисуют не компоненты-пузыри, а
 * сами экраны: осталось 6 файлов и 24 записи.
 *
 * v4.32.414 забрал оба композера целиком — восемь волн нажатия и вспышку
 * перехода, — и тост входящего сообщения: 2 файла и 12 записей.
 *
 * v4.32.415 забрал сюжеты. Разница там оказалась не в цветах, а в том, что
 * под ними: поверх ЧУЖОГО кадра цвет измерить нельзя вовсе, пока под ним нет
 * плёнки, — и половина мест плёнки не имела. Осталась одна запись из двух
 * декораций на карте.
 */
const RGBA_BASELINE: Record<string, number> = {
  // Тень-эллипс под булавкой и белая обводка самой булавки: декорация поверх
  // карты, текста на них нет, мерить нечего (v4.32.412).
  'ui/components/LocationMessage.tsx': 2,
};

/** Записи `rgba(...)` в файле — только в коде, не в комментариях. */
function rgbaIn(source: string): string[] {
  const found: string[] = [];
  for (const line of codeLines(source)) {
    const matches = line.match(/rgba?\(\s*\d+\s*,/g);
    if (matches) found.push(...matches);
  }
  return found;
}

const ALPHA_EXEMPT: Record<string, string> = {
  // Единственная намеренно полупрозрачная величина палитры — волна нажатия;
  // её же собирает `applyAccent` (см. themeContrast.test.ts, раунд 407).
  'ui/theme.ts': 'волна нажатия — единственный полупрозрачный токен',
};

/** Путь относительно src, с прямыми слэшами — ключ и в BASELINE, и в EXEMPT. */
function relKey(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/');
}

describe('цвета, вписанные руками', () => {
  const counted = new Map<string, number>();
  for (const file of collect(SRC)) {
    const key = relKey(file);
    if (EXEMPT[key]) continue;
    const n = literalsIn(readFileSync(file, 'utf8')).length;
    if (n > 0) counted.set(key, n);
  }

  it('ни один файл не заводит новых литералов', () => {
    const grown: string[] = [];
    for (const [key, n] of counted) {
      const allowed = BASELINE[key] ?? 0;
      if (n > allowed) grown.push(`${key}: ${n} (было ${allowed})`);
    }
    // Сообщение объясняет, что делать: не поднять планку, а взять цвет из
    // палитры — иначе смысл теста теряется на первом же падении.
    expect(grown.join('\n')).toBe('');
  });

  it('цвет не склеивается с прозрачностью на месте вызова', () => {
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      const key = relKey(file);
      if (ALPHA_EXEMPT[key]) continue;
      const found = alphaMixesIn(readFileSync(file, 'utf8'));
      if (found.length > 0) offenders.push(`${key}: ${found.join(', ')}`);
    }
    // Что делать вместо: badgeTint / tintedPlate / nestedFill — они считают
    // НЕПРОЗРАЧНУЮ подложку от поверхности, а чернила уже от подложки.
    expect(offenders.join('\n')).toBe('');
  });

  it('планка опускается вслед за исправлениями', () => {
    const stale: string[] = [];
    for (const [key, allowed] of Object.entries(BASELINE)) {
      const n = counted.get(key) ?? 0;
      if (n < allowed) stale.push(`${key}: ${n} (в списке ${allowed})`);
    }
    expect(stale.join('\n')).toBe('');
  });
});

describe('цвета, заданные прозрачностью', () => {
  const counted = new Map<string, number>();
  for (const file of collect(SRC)) {
    const key = relKey(file);
    if (RGBA_EXEMPT[key]) continue;
    const n = rgbaIn(readFileSync(file, 'utf8')).length;
    if (n > 0) counted.set(key, n);
  }

  it('ни один файл не заводит новых rgba', () => {
    const grown: string[] = [];
    for (const [key, n] of counted) {
      const allowed = RGBA_BASELINE[key] ?? 0;
      if (n > allowed) grown.push(`${key}: ${n} (было ${allowed})`);
    }
    // Что делать вместо: bubbleSurface / nestedFill / badgeTint / mediaScrim —
    // все они возвращают НЕПРОЗРАЧНЫЙ цвет, который можно измерить.
    expect(grown.join('\n')).toBe('');
  });

  it('планка опускается вслед за исправлениями', () => {
    const stale: string[] = [];
    for (const [key, allowed] of Object.entries(RGBA_BASELINE)) {
      const n = counted.get(key) ?? 0;
      if (n < allowed) stale.push(`${key}: ${n} (в списке ${allowed})`);
    }
    expect(stale.join('\n')).toBe('');
  });

  /**
   * Плёнка под окном писалась руками 50 раз и тринадцатью разными числами.
   * Теперь она одна; единственное исключение — тень под булавкой на карте,
   * на которой ничего не написано.
   */
  it('чёрную плёнку руками больше не пишут', () => {
    const BLACK_FILM_EXEMPT = new Set(['ui/components/LocationMessage.tsx']);
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      const key = relKey(file);
      if (RGBA_EXEMPT[key] || BLACK_FILM_EXEMPT.has(key)) continue;
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        if (/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(line)) offenders.push(`${key}: ${line.trim().slice(0, 80)}`);
      }
    }
    // Что писать вместо: scrim.modal — под диалогом, scrim.viewer — под
    // полноэкранным просмотром, mediaScrim.bar — поверх чужого кадра.
    expect(offenders.join('\n')).toBe('');
  });

  /**
   * Содержимое пузыря живёт не только в каталогах с говорящими именами.
   * `DocBubble` лежит в `chat-components/`, но рисует и групповые сообщения;
   * `VoicePlayer`, `GifBubble` и сам `ChatScreen` не лежат ни в одном из этих
   * каталогов, а пузырей рисуют больше всех.
   *
   * v4.32.413: проверка 411-го фильтровала по каталогу и потому не видела
   * самого крупного нарушителя — четырнадцати записей в `ChatScreen.tsx`.
   * Утверждение было шире своей области; теперь область равна утверждению.
   */
  it('в содержимом пузырей прозрачных цветов не осталось', () => {
    const BUBBLE_FILES = new Set([
      'ui/components/GifPicker.tsx',
      'ui/components/RichText.tsx',
      'ui/components/VoiceMessage.tsx',
      'ui/screens/ChatScreen.tsx',
      'ui/screens/GroupsScreen.tsx',
    ]);
    const offenders: string[] = [];
    for (const file of collect(SRC)) {
      const key = relKey(file);
      if (RGBA_EXEMPT[key]) continue;
      const inBubble = key.includes('chat-components/') || key.includes('groups-components/') || BUBBLE_FILES.has(key);
      if (!inBubble) continue;
      for (const line of codeLines(readFileSync(file, 'utf8'))) {
        // v4.32.413 выводил отсюда волну нажатия и пульс подсветки строки —
        // «у них свой раунд». Раунд был 414-м, и исключение снято: волна
        // считается от заливки (`rippleOn`), пульс — от `colors.star`
        // (`rowMark`), и ни одному из них литерал больше не нужен.
        if (/rgba?\(\s*\d+\s*,/.test(line)) offenders.push(`${key}: ${line.trim().slice(0, 90)}`);
      }
    }
    // Что писать вместо: useBubbleSurface() — заливка, чернила и вложенная
    // плашка текущего пузыря; bubbleSurfaceOn(colors, fill, mine) — когда
    // заливку экран уже посчитал сам.
    expect(offenders.join('\n')).toBe('');
  });
});
