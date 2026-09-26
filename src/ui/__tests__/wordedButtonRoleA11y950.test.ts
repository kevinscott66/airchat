/**
 * Кнопка со словом на ней объявлена кнопкой (v4.32.950).
 *
 * Дефект. Семьдесят восемь нажимаемых мест, внутри которых нет ничего, кроме
 * надписи собственными словами — «Отмена», «Сохранить», «Удалить папку»,
 * «Принять», — не объявляли себя кнопками. Озвучка читала такое место как
 * обычный текст: слово произносилось, но «кнопка» после него не звучало и в
 * список элементов управления оно не попадало.
 *
 * Цена. Человек, который не видит экрана, обходит диалог по элементам
 * управления. Кнопки «Сохранить» и «Отмена» в этом обходе не встречались
 * вовсе: закрыть окно или подтвердить ввод было нечем, пока не наткнёшься на
 * них перебором всего подряд. В диалоге удаления папки и разблокировки
 * контакта это значит, что до действия не добраться.
 *
 * Правка. `accessibilityRole="button"` на каждое такое место. Надпись уже
 * прочитана содержимым, и подменять её `accessibilityLabel` не нужно — это
 * лишь отняло бы у озвучки правку текста при переводе. Двум местам добавлено
 * и `selected`: это не команды, а выбор («Все истории» в полосе альбомов,
 * «Завтра» в отложенной отправке), и озвучке важно, включён он или нет.
 *
 * Границы. Правило узкое намеренно. Роль требуется только там, где внутри
 * нажимаемого РОВНО одна надпись И в этой надписи есть собственные слова, а
 * не одна подстановка. `{item.name}`, `{tag}`, `{emoji}` под правило не
 * попадают: там внутри имя сущности, и такое место с равным правом бывает
 * строкой списка, а не кнопкой. Обёртка `AppPressable` роли по умолчанию не
 * имеет намеренно (см. её собственную запись), и это правило её не отменяет —
 * оно лишь называет тот случай, где «кнопка» верна наверняка.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const UI = join(__dirname, '..');

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

/** Открывающий тег целиком: `{}` и кавычки внутри не обрывают его. */
function openingTag(source: string, from: number): string {
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

/** То, что осталось от содержимого надписи за вычетом всех подстановок. */
function outsideBraces(text: string): string {
  let depth = 0;
  let out = '';
  for (const c of text) {
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 0) out += c;
  }
  return out;
}

const PRESSABLE = /<(AppPressable|Pressable|TouchableOpacity)\b/g;

type Site = { file: string; line: number; label: string; tag: string };

/** Нажимаемые, внутри которых ровно одна надпись собственными словами. */
function scanWordedButtons(): Site[] {
  const out: Site[] = [];
  for (const full of collect(UI)) {
    const src = readFileSync(full, 'utf8');
    const file = relative(UI, full);
    PRESSABLE.lastIndex = 0;
    for (let m = PRESSABLE.exec(src); m !== null; m = PRESSABLE.exec(src)) {
      const tag = openingTag(src, m.index);
      if (tag.endsWith('/>')) continue;
      const bodyStart = m.index + tag.length;
      const bodyEnd = src.indexOf(`</${m[1]}>`, bodyStart);
      if (bodyEnd === -1) continue;
      const body = src.slice(bodyStart, bodyEnd);
      // Ровно одна надпись и ничего больше: ни значка, ни вложенной разметки.
      const elements = [...body.matchAll(/<([A-Z][\w.]*)/g)].map((e) => e[1]);
      if (elements.length !== 1 || elements[0] !== 'Text') continue;
      const textAt = body.indexOf('<Text');
      const textTag = openingTag(body, textAt);
      const inner = body.slice(textAt + textTag.length, body.lastIndexOf('</Text>')).trim();
      if (!/[A-Za-zА-Яа-яЁё]/.test(outsideBraces(inner))) continue;
      out.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        label: inner.replace(/\s+/g, ' ').slice(0, 60),
        tag,
      });
    }
  }
  return out;
}

const sites = scanWordedButtons();

describe('ПРОВЕРКА НЕ ПУСТАЯ: обход находит кнопки со словом', () => {
  it('таких мест в доме не меньше семидесяти', () => {
    expect(sites.length).toBeGreaterThanOrEqual(70);
  });

  it('разбор тега не обрывается на «>» внутри выражения и кавычек', () => {
    expect(openingTag('<A n={x > 1 ? 2 : 3} b="c>d">тело', 0)).toBe('<A n={x > 1 ? 2 : 3} b="c>d">');
  });

  it('подстановки из надписи вычтены, а слова оставлены', () => {
    expect(outsideBraces('{unread} непрочитанных — обновить').trim()).toBe('непрочитанных — обновить');
    expect(outsideBraces('{tag}').trim()).toBe('');
  });

  it('найдены «Отмена» и «Сохранить» — самые частые из них', () => {
    expect(sites.filter((s) => s.label === 'Отмена').length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((s) => s.label === 'Сохранить').length).toBeGreaterThanOrEqual(5);
  });
});

describe('у каждой такой кнопки озвучка слышит «кнопка»', () => {
  it('без роли не осталось ни одной', () => {
    const bad = sites
      .filter((s) => !/accessibilityRole=/.test(s.tag))
      .map((s) => `${s.file}:${s.line} (${s.label})`);
    expect(bad).toEqual([]);
  });

  it('роль везде «кнопка», кроме единственного названного исключения', () => {
    /**
     * Строка «Версия N» в настройках объявлена не кнопкой, а текстом, и это
     * намеренно: нажатие на неё открывает режим разработчика после седьмого
     * подряд. Назвав её кнопкой, разметка выдала бы озвучке спрятанное — а
     * заодно пообещала бы действие, которого от одного нажатия не будет.
     */
    const others = sites
      .filter((s) => !/accessibilityRole="button"/.test(s.tag))
      .map((s) => `${s.file}:${s.line}`);
    expect(others).toEqual([join('screens', 'SettingsScreen.tsx') + ':1678']);
    const settings = readFileSync(join(UI, 'screens', 'SettingsScreen.tsx'), 'utf8');
    expect(settings).toContain('style={styles.versionTap} accessibilityRole="text"');
  });

  it('пустым ярлыком надпись не заглушена', () => {
    // Ярлык здесь не обязателен: надпись уже прочитана содержимым, и её правит
    // перевод. Но если ярлык поставлен, он обязан что-то говорить — пустая
    // строка отняла бы у озвучки и то слово, которое было.
    const bad = sites
      .filter((s) => /accessibilityLabel=(""|\{''\}|\{``\})/.test(s.tag))
      .map((s) => `${s.file}:${s.line}`);
    expect(bad).toEqual([]);
  });
});

describe('выбор отличён от команды', () => {
  const at = (file: string, line: number): Site | undefined =>
    sites.find((s) => s.file === file && s.line === line);

  it('чип «Все истории» сообщает, выбран ли он', () => {
    const s = at(join('components', 'modals', 'profile', 'ProfilePostsModal.tsx'), 475);
    expect(s?.tag).toContain('accessibilityState={{ selected: albumId === null }}');
  });

  it('переключатель «Завтра» сообщает, включён ли он', () => {
    // v4.32.982: строка уехала на 91 — выше по файлу списку заготовок
    // («Через 10 минут», «Через час») добавили роль.
    const s = at(join('components', 'modals', 'chat', 'ChatScheduleModal.tsx'), 91);
    expect(s?.tag).toContain('accessibilityState={{ selected: customTomorrow }}');
  });
});

describe('находка #4: чипы и полосы ленты', () => {
  const feed = readFileSync(join(UI, 'screens', 'FeedScreen.tsx'), 'utf8');

  it('чип обсуждаемой метки говорит, что он делает', () => {
    expect(feed).toContain('accessibilityLabel={`Показать только ${tag}`}');
  });

  it('снятие отбора по метке названо словом, а не крестиком', () => {
    expect(feed).toContain('accessibilityLabel={`${activeHashtag} — снять отбор`}');
  });

  it('полоса скрытых авторов и полоса очереди объявлены кнопками', () => {
    expect(feed).toContain('<AppPressable style={styles.queueBanner} onPress={onFlushQueueNow} testID="feed_queue_banner" accessibilityRole="button">');
    const muted = feed.indexOf("t('feed.mutedCount'");
    expect(muted).toBeGreaterThan(0);
    const tagStart = feed.lastIndexOf('<AppPressable', muted);
    expect(openingTag(feed, tagStart)).toContain('accessibilityRole="button"');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: роль не расставлена скопом', () => {
  it('нажимаемые с одной подстановкой внутри так и остались без роли', () => {
    // `{item.name}`, `{tag}`, `{emoji}` — это с равным правом строка списка, и
    // «кнопка» на ней соврала бы озвучке не реже, чем молчание.
    let bare = 0;
    for (const full of collect(UI)) {
      const src = readFileSync(full, 'utf8');
      PRESSABLE.lastIndex = 0;
      for (let m = PRESSABLE.exec(src); m !== null; m = PRESSABLE.exec(src)) {
        const tag = openingTag(src, m.index);
        if (tag.endsWith('/>') || /accessibilityRole=/.test(tag)) continue;
        const bodyStart = m.index + tag.length;
        const bodyEnd = src.indexOf(`</${m[1]}>`, bodyStart);
        if (bodyEnd === -1) continue;
        const body = src.slice(bodyStart, bodyEnd);
        const elements = [...body.matchAll(/<([A-Z][\w.]*)/g)].map((e) => e[1]);
        if (elements.length !== 1 || elements[0] !== 'Text') continue;
        const textAt = body.indexOf('<Text');
        const inner = body.slice(textAt + openingTag(body, textAt).length, body.lastIndexOf('</Text>')).trim();
        if (!/[A-Za-zА-Яа-яЁё]/.test(outsideBraces(inner))) bare += 1;
      }
    }
    expect(bare).toBeGreaterThanOrEqual(20);
  });

  it('обёртка по-прежнему не выдаёт роль по умолчанию', () => {
    const wrapper = readFileSync(join(UI, 'components', 'AppPressable.tsx'), 'utf8');
    expect(wrapper).toContain('По умолчанию роли НЕТ, и это намеренно');
    expect(wrapper).not.toContain('accessibilityRole="button"');
  });
});
