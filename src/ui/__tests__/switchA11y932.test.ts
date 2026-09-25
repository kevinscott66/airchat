/**
 * Храповик на имя переключателя.
 *
 * Дефект. Двадцать четыре переключателя в настройках стояли рядом со своей
 * подписью — и ни один её не знал. Подпись нарисована соседним `<Text>`, а
 * `<AppSwitch>` уходил в нативный слой без `accessibilityLabel`, то есть
 * безымянным. Одно место из двадцати четырёх имя имело
 * (`GroupSettingsModal`), и именно оно показывает, что в этом нет ничего
 * трудного.
 *
 * Цена. VoiceOver читает такой ряд как «Тихие часы» и следом — «выключено»,
 * двумя отдельными остановками. Пока палец идёт подряд, это ещё связывается;
 * при поиске по элементам, при шрифте, разносящем строку, и на любом экране,
 * где переключателей десяток, человек слышит десять одинаковых «выключено»
 * подряд и не знает, что именно выключено. Настройки приватности и
 * автоблокировки — не то место, где можно переключать наугад.
 *
 * Правка. Каждому переключателю дано имя, и имя не новое: это ровно та
 * строка, что нарисована рядом. Держит их вместе не договорённость, а вот
 * этот файл: он находит каждый `<AppSwitch>` в `src`, поднимается к ближайшей
 * подписи над ним и требует посимвольного совпадения. Разойтись им негде —
 * ни при правке текста, ни при добавлении нового переключателя.
 *
 * Границы. Проверка смотрит на исходник, а не на дерево: подпись и имя должны
 * совпадать в тексте файла. Динамическая подпись сравнивается как выражение —
 * `{item.label}` рядом с `{item.label}`, `{Platform.OS === 'ios' ? … : …}`
 * рядом с тем же тернарником. Что именно вернёт выражение, здесь не
 * проверяется: важно, что глаз и озвучка читают одно и то же.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

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

/** Подпись ряда: `<Text>` со стилем label / switchLabel / rowLabel. */
const LABEL_LINE = /<Text style=\{[^>]*styles\.(?:label|switchLabel|rowLabel)\b[^>]*\}>(.*?)<\/Text>/;

/**
 * Содержимое `accessibilityLabel` в куске исходника: строка в кавычках или
 * выражение в фигурных скобках, посчитанное по балансу скобок.
 */
function a11yValue(block: string): string | null {
  const at = block.indexOf('accessibilityLabel=');
  if (at < 0) return null;
  const rest = block.slice(at + 'accessibilityLabel='.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end < 0 ? null : rest.slice(1, end);
  }
  if (!rest.startsWith('{')) return null;
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    else if (rest[i] === '}') {
      depth--;
      if (depth === 0) return rest.slice(0, i + 1);
    }
  }
  return null;
}

export type SwitchSite = { line: number; label: string | null; named: string | null };

/** Все `<AppSwitch>` файла: где стоит, что нарисовано рядом, как назван. */
function switchSites(source: string): SwitchSite[] {
  const lines = source.split('\n');
  const out: SwitchSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('<AppSwitch')) continue;
    let label: string | null = null;
    for (let k = i - 1; k >= 0 && k >= i - 40; k--) {
      const m = LABEL_LINE.exec(lines[k]);
      if (m) { label = m[1].trim(); break; }
    }
    // Элемент целиком: от `<AppSwitch` до закрывающего `/>`.
    let block = '';
    for (let k = i; k < lines.length && k < i + 40; k++) {
      block += lines[k] + '\n';
      if (lines[k].includes('/>')) break;
    }
    out.push({ line: i + 1, label, named: a11yValue(block) });
  }
  return out;
}

/** Чем провинился ряд: без подписи, без имени или имя не то. */
function offences(source: string, key = ''): string[] {
  const bad: string[] = [];
  for (const s of switchSites(source)) {
    const where = `${key}:${s.line}`;
    if (s.label === null) { bad.push(`${where} рядом нет подписи`); continue; }
    if (s.named === null) { bad.push(`${where} переключатель без имени: «${s.label}»`); continue; }
    if (s.named !== s.label) bad.push(`${where} имя «${s.named}» не совпадает с подписью «${s.label}»`);
  }
  return bad;
}

const FILES = collect(SRC).map((full) => ({
  key: full.slice(SRC.length + 1).split('\\').join('/'),
  source: readFileSync(full, 'utf8'),
})).filter((f) => f.source.includes('<AppSwitch'));

describe('переключатель называет себя тем же словом, что нарисовано рядом', () => {
  it('переключатели вообще нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(6);
    const total = FILES.reduce((n, f) => n + switchSites(f.source).length, 0);
    expect(total).toBeGreaterThanOrEqual(23);
  });

  it('у каждого переключателя есть имя, и это подпись рядом', () => {
    const bad: string[] = [];
    for (const f of FILES) bad.push(...offences(f.source, f.key));
    expect(bad).toEqual([]);
  });

  it('оба экрана настроек и все четыре раздела связи — в списке', () => {
    const keys = FILES.map((f) => f.key);
    expect(keys).toContain('ui/screens/SettingsScreen.tsx');
    expect(keys).toContain('ui/components/RelaySettingsSection.tsx');
    expect(keys).toContain('ui/components/AgentBridgeSettingsSection.tsx');
    expect(keys).toContain('ui/components/VpnSettingsSection.tsx');
    expect(keys).toContain('ui/components/OpenFluxSettingsSection.tsx');
    expect(keys).toContain('ui/components/modals/groups/GroupSettingsModal.tsx');
  });

  it('динамическая подпись держится наравне с обычной', () => {
    const src = [
      '<View style={styles.row}>',
      '  <Text style={[styles.rowLabel, { color: colors.text }]}>{item.label}</Text>',
      '  <AppSwitch value={item.toggle} accessibilityLabel={item.label} onValueChange={f} />',
      '</View>',
    ].join('\n');
    expect(switchSites(src)[0]).toEqual({ line: 3, label: '{item.label}', named: '{item.label}' });
    expect(offences(src)).toEqual([]);
  });

  it('тернарник в подписи разбирается по балансу скобок, а не до первой', () => {
    const src = [
      "  <Text style={styles.label}>{Platform.OS === 'ios' ? 'Face ID' : 'Отпечаток'}</Text>",
      '  <AppSwitch',
      "    accessibilityLabel={Platform.OS === 'ios' ? 'Face ID' : 'Отпечаток'}",
      '    value={bioEnabled}',
      '  />',
    ].join('\n');
    expect(offences(src)).toEqual([]);
  });
});

describe('правило не вырождено', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: прежняя запись опознаётся как безымянная', () => {
    // Дословно то, как ряд выглядел до v4.32.932.
    const before = [
      '<View style={styles.switchRow}>',
      '  <View style={styles.rowBody}>',
      '    <Text style={styles.label}>Тихие часы</Text>',
      '    <Text style={styles.desc}>Уведомления отключены в заданные часы</Text>',
      '  </View>',
      '  <AppSwitch value={dndEnabled} onValueChange={onDnd} />',
      '</View>',
    ].join('\n');
    const bad = offences(before, 'было');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('без имени');
    expect(bad[0]).toContain('Тихие часы');
  });

  it('разошедшиеся слова тоже видны, а не только пустое место', () => {
    const drifted = [
      '  <Text style={styles.label}>Звук уведомления</Text>',
      '  <AppSwitch accessibilityLabel="Звук" value={notifySound} onValueChange={f} />',
    ].join('\n');
    const bad = offences(drifted, 'разъехалось');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain('не совпадает');
  });

  it('подпись соседнего ряда не выдаётся за свою', () => {
    // Подпись ищется выше переключателя; если её там нет вовсе — это тоже
    // нарушение, а не молчаливое «нашлась где-то».
    const orphan = '  <AppSwitch value={x} onValueChange={f} />';
    expect(switchSites(orphan)[0].label).toBeNull();
    expect(offences(orphan, 'сирота')[0]).toContain('нет подписи');
  });

  it('описание ряда за подпись не принимается', () => {
    // `styles.desc` — второй строкой в том же ряду. Возьми правило его — и имя
    // переключателя стало бы абзацем текста.
    const src = [
      '  <Text style={styles.label}>Вибрация</Text>',
      '  <Text style={styles.desc}>Вибросигнал при получении уведомления</Text>',
      '  <AppSwitch accessibilityLabel="Вибрация" value={v} onValueChange={f} />',
    ].join('\n');
    expect(switchSites(src)[0].label).toBe('Вибрация');
    expect(offences(src)).toEqual([]);
  });

  it('кавычки и скобки разбираются, а не угадываются', () => {
    expect(a11yValue('accessibilityLabel="Звонки" value={x}')).toBe('Звонки');
    expect(a11yValue('accessibilityLabel={item.label} onValueChange={f}')).toBe('{item.label}');
    expect(a11yValue('accessibilityLabel={a ? {b: 1} : {c: 2}} value={x}')).toBe('{a ? {b: 1} : {c: 2}}');
    expect(a11yValue('value={x} onValueChange={f}')).toBeNull();
  });
});
