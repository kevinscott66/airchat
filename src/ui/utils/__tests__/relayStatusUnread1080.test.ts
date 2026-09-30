/**
 * ДЕФЕКТ (v4.32.1080). Настройки доставки выдавали непрочитанный файл своих
 * настроек за сознательный выбор общего ntfy.sh.
 *
 * Свои настройки лежат в Documents/airchat-config.json. Читателей у файла было
 * два. Пишущий (readConfigOverride) различал три исхода: файла нет, файл
 * прочитан, файл есть — но не прочитался. Читающий при старте
 * (readUserOverride) сводил любую беду — занятую песочницу, обрывок после
 * прерванной записи, подложенный файл сверх потолка, не-объект внутри — к
 * пустому `{}`. Пустой патч означает заводские умолчания, то есть публичный
 * ntfy.sh. Секция настроек спрашивала у loadConfig адрес, получала умолчание и
 * рисовала зелёную точку с подписью «Общий ntfy.sh».
 *
 * ЦЕНА. Свой ретранслятор ставят ровно затем, чтобы список тем и время
 * отправки не видел посторонний: сами сообщения зашифрованы, а метаданные —
 * нет. Человек открывает настройки, видит зелёную точку и уходит, не узнав,
 * что этот запуск он проговорил через чужой сервер. Настройки при этом целы:
 * следующий запуск прочитает файл как надо, и беда не оставит следа. То же
 * касается выключенной доставки: серая точка и «Выключен — только локальная
 * сеть» при непрочитанном файле — тоже утверждение о выборе, которого никто
 * не делал.
 *
 * ПРАВКА. Читатель остался один — тот, что различает три исхода. Для самой
 * загрузки `null` по-прежнему сводится к `{}` (решение v4.32.729 в силе: один
 * запуск на умолчаниях обратим, а стёртый файл нет), но исход запоминается и
 * доступен через configOverrideUnread(). Секция берёт его при открытии и
 * говорит о нём: янтарная точка и «Свои настройки не прочитались. Сейчас
 * работает …».
 *
 * ГРАНИЦЫ. Ни загрузка конфига, ни транспорт не меняются: подпись говорит о
 * том, что уже произошло, а не отменяет это. Прочитанный файл — прежние слова
 * и прежний цвет. Удавшееся сохранение снимает предупреждение: оно проходит
 * только через прочитанные настройки.
 */
import fs from 'fs';
import path from 'path';

import { relayStatusLine, type RelayStatusFacts } from '../relayStatus';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const CONFIG = () => read('core', 'config.ts');
const SECTION = () => read('ui', 'components', 'RelaySettingsSection.tsx');

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
  const b = src.indexOf(to, a);
  if (b < 0) throw new Error(`не нашли конец: ${to}`);
  return src.slice(a, b);
}

const MY = 'https://ntfy.example.org';

const base: RelayStatusFacts = {
  enabled: true,
  activeBase: 'https://ntfy.sh',
  custom: false,
  unread: false,
};

describe('что говорит секция о сервере доставки', () => {
  it('непрочитанный файл назван непрочитанным, а не «общий ntfy.sh»', () => {
    const line = relayStatusLine({ ...base, unread: true });
    expect(line.tone).toBe('warn');
    expect(line.text).toContain('Свои настройки не прочитались');
    expect(line.text).not.toBe('Общий ntfy.sh');
  });

  it('незнание сильнее выключенного рычажка: он тоже из умолчаний', () => {
    // enabled=false при непрочитанном файле — это заводское умолчание,
    // применённое к пустому патчу, а не выбор человека.
    const line = relayStatusLine({ ...base, enabled: false, unread: true });
    expect(line.tone).toBe('warn');
    expect(line.text).not.toContain('Выключен');
  });

  it('при незнании сказано, через что работаем сейчас', () => {
    expect(relayStatusLine({ ...base, unread: true }).text).toContain('общий ntfy.sh');
    expect(
      relayStatusLine({ ...base, activeBase: MY, custom: true, unread: true }).text,
    ).toContain(MY);
  });

  it('три состояния — три разных цвета и три разных подписи', () => {
    const lines = [
      relayStatusLine(base),
      relayStatusLine({ ...base, enabled: false }),
      relayStatusLine({ ...base, unread: true }),
    ];
    expect(new Set(lines.map((l) => l.tone)).size).toBe(3);
    expect(new Set(lines.map((l) => l.text)).size).toBe(3);
    lines.forEach((l) => expect(l.text.length).toBeGreaterThan(0));
  });
});

describe('ГРАНИЦА: прочитанный файл говорит прежними словами', () => {
  it('общий сервер — прежняя подпись и зелёная точка', () => {
    expect(relayStatusLine(base)).toEqual({ tone: 'ok', text: 'Общий ntfy.sh' });
  });

  it('свой сервер — сам адрес, как и раньше', () => {
    expect(relayStatusLine({ ...base, activeBase: MY, custom: true })).toEqual({
      tone: 'ok',
      text: MY,
    });
  });

  it('выключенная доставка — прежняя подпись и серая точка', () => {
    expect(relayStatusLine({ ...base, enabled: false })).toEqual({
      tone: 'muted',
      text: 'Выключен — только локальная сеть',
    });
  });

  it('выключенная доставка важнее адреса — как и было', () => {
    expect(relayStatusLine({ ...base, enabled: false, activeBase: MY, custom: true }).tone).toBe(
      'muted',
    );
  });

  it('решение о цвете ничего не читает само: модуль без импортов', () => {
    const src = read('ui', 'utils', 'relayStatus.ts');
    expect(src).not.toContain('\nimport ');
  });
});

describe('форма правки', () => {
  it('читатель при старте один, и его исход запоминается', () => {
    const code = codeOnly(CONFIG());
    expect(code).toContain('const read = await readConfigOverride();');
    expect(code).toContain('overrideUnread = read === null;');
    expect(code).toContain('const patch = read ?? {};');
    // Прежний лишний читатель, сводивший отказ к `{}`, удалён целиком.
    expect(CONFIG()).not.toContain('readUserOverride');
  });

  it('исход доступен снаружи отдельной функцией', () => {
    expect(codeOnly(CONFIG())).toContain('export function configOverrideUnread(): boolean {');
  });

  it('удавшееся сохранение снимает незнание', () => {
    const save = slice(CONFIG(), 'export async function saveConfigOverride(', '\n}\n');
    expect(save).toContain('overrideUnread = false;');
  });

  it('секция спрашивает исход при открытии и снимает его после записи', () => {
    const src = SECTION();
    expect(src).toContain('setUnread(configOverrideUnread());');
    // Сохранение и возврат к общему серверу проходят только через прочитанные
    // настройки — после них предупреждать не о чем.
    expect(src.split('setUnread(false);').length - 1).toBe(2);
  });

  it('цвет точки и подписи берётся у решения, а не собирается на месте', () => {
    const src = SECTION();
    expect(src).toContain('const status = relayStatusLine({ enabled, activeBase, custom, unread });');
    expect(src).toContain('{status.text}');
    expect(src).toContain('styles.dotWarn');
    expect(src).toContain('dotWarn: { backgroundColor: c.warning },');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('отказ записи при непрочитанных настройках цел (v4.32.729)', () => {
    expect(CONFIG()).toContain(
      'Не удалось прочитать текущие настройки. Изменение не сохранено, прежние настройки целы',
    );
    expect(codeOnly(CONFIG())).toContain('const existingOverride = await readConfigOverride();');
  });

  it('возврат отодвинутой копии перед чтением цел (v4.32.967)', () => {
    const reader = slice(CONFIG(), 'async function readConfigOverride(', 'const uri =');
    expect(reader).toContain('if (!(await restoreStrandedOverride())) return null;');
  });

  it('потолок на размер файла цел (v4.32.581)', () => {
    const reader = slice(CONFIG(), 'async function readConfigOverride(', '\n}\n');
    expect(reader).toContain("log.warn('config_override_too_big'");
    expect(reader).toContain('return null;');
  });

  it('секция по-прежнему берёт адрес и рычажок у загруженного конфига', () => {
    const src = SECTION();
    expect(src).toContain('const cfg = await loadConfig();');
    expect(src).toContain("setEnabled(cfg.internet?.enabled !== false);");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('читатель и правда отвечает «не прочитали» несколькими путями', () => {
    // Если бы отказ был один и невероятный, разделять состояния было бы не за
    // чем. Их четыре, и все — обычная жизнь песочницы.
    const reader = slice(CONFIG(), 'async function readConfigOverride(', '\n}\n');
    expect(reader.split('return null;').length - 1).toBeGreaterThanOrEqual(4);
    expect(reader).toContain('} catch (e) {');
  });

  it('загрузка при отказе всё равно идёт на умолчаниях — менялось только слово', () => {
    // Решение v4.32.729 не отменено: падать на старте из-за занятой песочницы
    // нельзя. Значит подпись — единственное, что стоит между человеком и
    // молчаливым уходом на чужой сервер.
    const load = codeOnly(slice(CONFIG(), 'export async function loadConfig(', 'finalizeConfig'));
    expect(load).toContain('const patch =');
    expect(load).not.toContain('throw');
  });

  it('умолчание — это правда публичный ntfy.sh, а не пустота', () => {
    // Без этого «ушли на умолчания» звучало бы безобидно: по умолчанию адрес
    // не пустой, а чужой сервер, через который пойдут все метаданные.
    const relay = read('core', 'transport', 'internet', 'relayConfig.ts');
    expect(relay).toContain("export const DEFAULT_RELAY_BASE = 'https://ntfy.sh';");
    expect(relayStatusLine(base).text).toBe('Общий ntfy.sh');
  });
});
