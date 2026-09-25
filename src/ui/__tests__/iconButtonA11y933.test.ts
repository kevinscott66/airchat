/**
 * Храповик на крестик и стрелку.
 *
 * Дефект. Пятьдесят две кнопки по всему приложению состояли из одного значка
 * и ничего о себе не сообщали. Закрыть лист, вернуться назад, очистить поле
 * поиска, убрать выбранный файл, перелистнуть фотографию — всё это VoiceOver
 * читал одинаково: «кнопка». Больше сказать было нечего: внутри кнопки лежал
 * `<Ionicons>`, а у него имени нет и быть не может.
 *
 * Цена. Незрячий человек в чужом списке кнопок без имён не закрывает лист —
 * он гадает. В просмотрщике фотографий три такие кнопки стоят подряд
 * (закрыть, предыдущее, следующее), и «кнопка, кнопка, кнопка» не даёт ни
 * одного способа их различить, кроме как нажать и посмотреть, что вышло.
 *
 * Правка. Каждой дано имя того действия, которое она совершает, а не того
 * значка, которым нарисована. Значок один и тот же у четырёх разных дел:
 * `close` закрывает лист, но он же в `close-circle` очищает поле поиска и
 * убирает вложение; `arrow-back` возвращает назад, но в просмотрщике та же
 * стрелка листает фотографию. Поэтому раскладка «значок → слово» была бы
 * ложью вслух, и имена расставлены по действию поимённо.
 *
 * Границы. Правило требует имя только там, где нажимаемое состоит из одного
 * значка. Если внутри есть `<Text>` — имя уже нарисовано, и второе не нужно:
 * так устроены полоса «Живая геолокация активна — нажмите, чтобы остановить»
 * и плашка с хэштегом. Это ровно то, о чём говорит `AppPressable`: роль и
 * подпись обязательны у действий, а не у всякой обёртки.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** Значки, которыми в доме рисуют «закрыть», «назад», «очистить», «убрать». */
const ICON = /<Ionicons\s+name="(?:close|close-outline|close-circle|chevron-back|arrow-back)"/;
const OPEN = /<(AppPressable|Pressable|TouchableOpacity)\b/;

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

export type IconButton = {
  line: number;
  /** Внутри есть нарисованный текст — тогда имя уже есть. */
  hasText: boolean;
  named: boolean;
  hasRole: boolean;
};

/**
 * Нажимаемое, внутри которого лежит такой значок: где открылось, что внутри.
 * Конец ищется по балансу одноимённых тегов — вложенные кнопки в доме есть.
 */
function iconButtons(source: string): IconButton[] {
  const lines = source.split('\n');
  const out: IconButton[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!ICON.test(lines[i])) continue;
    let start = -1;
    let tag = '';
    for (let k = i; k >= 0 && k >= i - 14; k--) {
      const m = OPEN.exec(lines[k]);
      if (m) { start = k; tag = m[1]; break; }
    }
    if (start < 0 || seen.has(start)) continue;
    seen.add(start);
    // Хвост кнопки: считаем одноимённые открытия и закрытия.
    let depth = 0;
    let end = start;
    for (let k = start; k < lines.length && k < start + 60; k++) {
      const opens = lines[k].split('<' + tag).length - 1;
      const closes = lines[k].split('</' + tag + '>').length - 1;
      const selfClosed = /\/>\s*$/.test(lines[k]) ? 1 : 0;
      depth += opens - closes - (opens > 0 ? selfClosed : 0);
      end = k;
      if (depth <= 0 && k > start) break;
      if (depth <= 0 && opens > 0 && selfClosed) break;
    }
    const body = lines.slice(start, end + 1).join('\n');
    const head = lines.slice(start, i + 1).join('\n');
    out.push({
      line: i + 1,
      hasText: /<Text\b/.test(body),
      named: /accessibilityLabel=/.test(head),
      hasRole: /accessibilityRole="button"/.test(head),
    });
  }
  return out;
}

/** Безымянные кнопки-значки. Кнопка с нарисованным текстом — не в счёт. */
function offences(source: string, key = ''): string[] {
  const bad: string[] = [];
  for (const b of iconButtons(source)) {
    if (b.hasText) continue;
    if (!b.named) bad.push(`${key}:${b.line} кнопка-значок без имени`);
    else if (!b.hasRole) bad.push(`${key}:${b.line} имя есть, роли нет`);
  }
  return bad;
}

const FILES = collect(SRC).map((full) => ({
  key: full.slice(SRC.length + 1).split('\\').join('/'),
  source: readFileSync(full, 'utf8'),
})).filter((f) => ICON.test(f.source));

describe('кнопка-значок говорит, что делает', () => {
  it('такие кнопки вообще нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(30);
    const total = FILES.reduce((n, f) => n + iconButtons(f.source).filter((b) => !b.hasText).length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
  });

  it('ни одной безымянной не осталось', () => {
    const bad: string[] = [];
    for (const f of FILES) bad.push(...offences(f.source, f.key));
    expect(bad).toEqual([]);
  });

  it('просмотрщик фотографий различает три соседние кнопки', () => {
    const viewer = FILES.find((f) => f.key === 'ui/components/MediaViewer.tsx');
    expect(viewer).toBeDefined();
    const src = viewer!.source;
    expect(src).toContain('accessibilityLabel="Закрыть"');
    expect(src).toContain('accessibilityLabel="Предыдущее"');
    expect(src).toContain('accessibilityLabel="Следующее"');
  });

  it('один значок — разные слова, потому что дела разные', () => {
    const by = (k: string): string => FILES.find((f) => f.key === k)!.source;
    // close-circle: очистить поле поиска…
    expect(by('ui/screens/chat-components/EmojiPanel.tsx')).toContain('accessibilityLabel="Очистить поиск"');
    // …и убрать выбранное вложение — тот же значок, другое дело.
    expect(by('ui/components/MediaPreviewModal.tsx')).toContain('accessibilityLabel="Убрать"');
    // arrow-back: назад…
    expect(by('ui/screens/HelpScreen.tsx')).toContain('accessibilityLabel="Назад"');
    // …и закрыть поиск внутри экрана, откуда «назад» уводило бы не туда.
    expect(by('ui/screens/GroupsScreen.tsx')).toContain('accessibilityLabel="Закрыть поиск"');
  });
});

describe('правило не вырождено', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежняя запись опознаётся как безымянная', () => {
    // Дословно то, как закрывающий крестик листа выглядел до v4.32.933.
    const before = [
      '                <AppPressable onPress={onClose}>',
      '                  <Ionicons name="close" size={20} color={colors.textMuted} />',
      '                </AppPressable>',
    ].join('\n');
    const bad = offences(before, 'было');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('без имени');
  });

  it('нарисованный текст освобождает от имени — и это видно', () => {
    // Полоса живой геолокации: крестик внутри, но нажимается вся полоса, и
    // имя у неё уже есть — прямо на ней написано, что будет по нажатию.
    const withText = [
      '          <AppPressable onPress={stop}>',
      '            <Text style={{ flex: 1 }}>Живая геолокация активна — нажмите, чтобы остановить</Text>',
      '            <Ionicons name="close-circle" size={18} color={ink} />',
      '          </AppPressable>',
    ].join('\n');
    expect(iconButtons(withText)[0].hasText).toBe(true);
    expect(offences(withText)).toEqual([]);
  });

  it('одного имени мало: без роли это не кнопка', () => {
    const noRole = [
      '  <AppPressable accessibilityLabel="Закрыть" onPress={onClose}>',
      '    <Ionicons name="close" size={20} color={c} />',
      '  </AppPressable>',
    ].join('\n');
    expect(offences(noRole, 'без роли')[0]).toContain('роли нет');
  });

  it('значок без кнопки под правило не попадает', () => {
    // Значок бывает и просто рисунком — в шапке рядом с заголовком.
    const plain = '  <Ionicons name="close" size={18} color={c} />';
    expect(iconButtons(plain)).toEqual([]);
    expect(offences(plain)).toEqual([]);
  });

  it('вложенная кнопка считается своей, а не чужой', () => {
    // Полоса «N непрочитанных» нажимается целиком, а крестик внутри неё —
    // отдельная кнопка. Имя нужно именно ей.
    const nested = [
      '      <AppPressable onPress={jump}>',
      '        <Text>{n} непрочитанных — нажмите, чтобы перейти</Text>',
      '        <AppPressable accessibilityRole="button" accessibilityLabel="Скрыть" onPress={hide}>',
      '          <Ionicons name="close" size={14} color={ink} />',
      '        </AppPressable>',
      '      </AppPressable>',
    ].join('\n');
    const found = iconButtons(nested);
    expect(found).toHaveLength(1);
    expect(found[0].named).toBe(true);
    expect(offences(nested)).toEqual([]);
  });
});
