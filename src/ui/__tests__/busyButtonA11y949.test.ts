/**
 * Кнопка, которая работает, больше не называется недоступной (v4.32.949).
 *
 * Дефект. Тридцать три нажимаемых места на время работы подменяют своё
 * содержимое крутилкой: `{sending ? <ActivityIndicator /> : <Ionicons />}`.
 * Глазами это читается сразу — значок исчез, крутится колесо. Озвучке не
 * говорилось ничего: `ActivityIndicator` для неё пуст, и кнопка просто
 * замолкала. Хуже того, двадцать два из этих мест на то же время ставят
 * `disabled`, а озвучка переводит его единственным словом — «недоступно».
 * Это неправда: кнопка не недоступна, она РАБОТАЕТ.
 *
 * Цена. Человек, который не видит экрана, нажимает «Отправить», слышит
 * «недоступно» и делает единственный разумный вывод — не сработало. Дальше
 * он либо жмёт ещё раз (второе сообщение тому же адресату, вторая выгрузка
 * копии в облако), либо уходит, считая, что не отправилось, хотя отправилось.
 *
 * Правка. К `disabled` добавлено `accessibilityState={{ disabled, busy }}` —
 * ровно так, как это уже сделано в доме: `PermissionsScreen.tsx:157`,
 * `LoadingScreen.tsx:99`, `VoiceMessage.tsx`. Сам `disabled` остаётся: он
 * защищает от второго нажатия, и снимать его нельзя. Меняется только то, что
 * озвучка теперь называет причину — «занято», а не «недоступно».
 *
 * Границы. Храповик требует `busy` не от всякой кнопки рядом с крутилкой, а
 * только там, где крутилка — ЕДИНСТВЕННОЕ содержимое ветки тернарника, а
 * вторая ветка не пуста, то есть где крутилка именно ПОДМЕНЯЕТ содержимое.
 * Поэтому шапка публикации в `FeedScreen` (крутилка стоит РЯДОМ с надписью
 * «Отправляется», и слово уже сказано) остаётся за границей правила по его
 * устройству, а не списком исключений.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const UI = join(__dirname, '..');

/** Все .tsx экрана и его составных частей, кроме самих проверок. */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Открывающий тег целиком, от `<` до парного `>`. Учитывает вложенные `{}` и
 * кавычки, иначе `size > 1 ?` внутри выражения обрубит тег на середине.
 */
export function openingTag(source: string, from: number): string {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return source.slice(from, i + 1);
  }
  return source.slice(from);
}

const PRESSABLE = /<(AppPressable|Pressable|TouchableOpacity)\b/g;

/**
 * Крутилка подменяет содержимое: она — единственное в ветке тернарника, и
 * вторая ветка не пуста. Именно этот случай озвучке нечем объяснить.
 */
const SWAP = /\{\s*([^{}?]+?)\s*\?\s*\(?\s*<ActivityIndicator\b[^>]*\/>\s*\)?\s*:\s*(\(|<|null)/g;

type Site = {
  file: string;
  line: number;
  condition: string;
  tag: string;
};

/** Места, где крутилка подменяет содержимое нажимаемого. */
function scanSwapSites(): Site[] {
  const out: Site[] = [];
  for (const full of collect(UI)) {
    const src = readFileSync(full, 'utf8');
    const file = relative(UI, full);
    PRESSABLE.lastIndex = 0;
    for (let m = PRESSABLE.exec(src); m !== null; m = PRESSABLE.exec(src)) {
      const tag = openingTag(src, m.index);
      if (tag.endsWith('/>')) continue;
      const close = `</${m[1]}>`;
      const bodyStart = m.index + tag.length;
      const bodyEnd = src.indexOf(close, bodyStart);
      if (bodyEnd === -1) continue;
      const inner = src.slice(bodyStart, bodyEnd);
      // Вложенное нажимаемое — чужая кнопка, и крутилка в ней принадлежит ей.
      if (/<(AppPressable|Pressable|TouchableOpacity)\b/.test(inner)) continue;
      SWAP.lastIndex = 0;
      const hit = [...inner.matchAll(SWAP)].find((h) => h[2] !== 'null');
      if (!hit) continue;
      out.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        condition: hit[1].trim(),
        tag,
      });
    }
  }
  return out;
}

const sites = scanSwapSites();
/** Значение `accessibilityState` целиком, вместе с парными скобками. */
function stateOf(tag: string): string | null {
  const at = tag.indexOf('accessibilityState={');
  if (at === -1) return null;
  const from = at + 'accessibilityState='.length;
  let depth = 0;
  let quote = '';
  for (let i = from; i < tag.length; i += 1) {
    const c = tag[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return tag.slice(from, i + 1); }
  }
  return null;
}

describe('ПРОВЕРКА НЕ ПУСТАЯ: обход вообще что-то находит', () => {
  it('подменяющих крутилок в доме не меньше тридцати', () => {
    expect(sites.length).toBeGreaterThanOrEqual(30);
  });

  it('разбор тега не обрывается на «>» внутри выражения и кавычек', () => {
    expect(openingTag('<A n={x > 1 ? 2 : 3} b="c>d">тело', 0)).toBe('<A n={x > 1 ? 2 : 3} b="c>d">');
  });

  it('найденные места — из разных файлов, а не из одного', () => {
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(10);
  });
});

describe('у каждой подменённой крутилки озвучка слышит «занято»', () => {
  it('без busy не осталось ни одного места', () => {
    const bad = sites
      .filter((s) => !/busy\s*:/.test(stateOf(s.tag) ?? ''))
      .map((s) => `${s.file}:${s.line} (${s.condition})`);
    expect(bad).toEqual([]);
  });

  it('там, где кнопка ещё и запрещена, озвучке сказано и это', () => {
    const bad = sites
      .filter((s) => /\sdisabled=\{/.test(s.tag))
      .filter((s) => !/disabled\s*:/.test(stateOf(s.tag) ?? ''))
      .map((s) => `${s.file}:${s.line}`);
    expect(bad).toEqual([]);
  });

  it('busy привязан к тому же признаку, что и подмена', () => {
    const bad = sites
      .filter((s) => {
        const state = stateOf(s.tag) ?? '';
        const busy = /busy\s*:\s*([^,}]+)/.exec(state);
        return busy === null || busy[1].trim() !== s.condition;
      })
      .map((s) => `${s.file}:${s.line} (${s.condition})`);
    expect(bad).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: правило не превратилось в «busy всем подряд»', () => {
  /**
   * Шапка публикации: крутилка стоит РЯДОМ с надписью «Отправляется», а не
   * вместо содержимого, и вторая ветка тернарника пуста. Слово озвучке уже
   * сказано текстом, и busy на кнопке «открыть автора» соврал бы: открыть
   * автора можно в любой момент, ничего не занято.
   */
  it('крутилка рядом с надписью в шапке публикации под правило не попала', () => {
    const src = readFileSync(join(UI, 'screens', 'FeedScreen.tsx'), 'utf8');
    expect(src).toContain('<ActivityIndicator size="small" color={colors.accent} style={styles.pendingSpinner} />');
    expect(src).toContain('<Text style={styles.pendingLabel}>{t(\'feed.sendingPending\')}</Text>');
    const header = sites.filter((s) => s.file === join('screens', 'FeedScreen.tsx') && s.line < 700);
    expect(header).toEqual([]);
  });

  it('busy не расставлен по всем нажимаемым скопом', () => {
    let pressables = 0;
    let withBusy = 0;
    for (const full of collect(UI)) {
      const src = readFileSync(full, 'utf8');
      PRESSABLE.lastIndex = 0;
      for (let m = PRESSABLE.exec(src); m !== null; m = PRESSABLE.exec(src)) {
        pressables += 1;
        if (/busy\s*:/.test(openingTag(src, m.index))) withBusy += 1;
      }
    }
    // Нажимаемых в доме сотни, а занятых — десятки: правило точечное.
    expect(pressables).toBeGreaterThan(withBusy * 5);
  });
});

describe('места, названные поимённо', () => {
  // v4.32.950: привязка была по номеру строки, и любая соседняя правка в том
  // же файле роняла проверку, ничего не сломав по существу. Место опознаётся
  // по файлу и признаку занятости — они и есть предмет, а номер строки нет.
  const at = (file: string, condition: string): Site | undefined =>
    sites.find((s) => s.file === file && s.condition === condition);

  it('отправка сообщения в переписке', () => {
    const s = at(join('screens', 'ChatScreen.tsx'), 'sending');
    expect(s).toBeDefined();
    expect(stateOf(s?.tag ?? '')).toContain('busy: sending');
  });

  it('рассылка по контактам', () => {
    const s = at(join('screens', 'ChatListScreen.tsx'), 'broadcastSending');
    expect(s).toBeDefined();
    const state = stateOf(s?.tag ?? '');
    expect(state).toContain('busy: broadcastSending');
    // Запрет тут составной: пустой текст, пустой список адресатов, отправка.
    expect(state).toContain("disabled: !broadcastMsg.trim() || broadcastSelected.size === 0 || broadcastSending");
  });

  it('выгрузка копии в облако', () => {
    const s = at(join('screens', 'SettingsScreen.tsx'), 'cloudBusy');
    expect(s).toBeDefined();
    const state = stateOf(s?.tag ?? '');
    expect(state).toContain('busy: cloudBusy');
    expect(state).toContain('disabled: !isCloudVaultConfigured() || cloudBusy');
  });

  it('открытие вложенного файла — там запрета нет, только занятость', () => {
    const s = at(join('screens', 'chat-components', 'DocBubble.tsx'), 'opening');
    expect(s).toBeDefined();
    expect(stateOf(s?.tag ?? '')).toBe('{{ busy: opening }}');
  });
});
