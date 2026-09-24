/**
 * v4.32.861. Недоступное голосовое в личной переписке рисовалось пустым
 * пузырём, а недоступное навсегда предлагало повторить загрузку.
 *
 * Дефект первый. Условие «адреса нет и вложения нет» в личном пузыре
 * заканчивалось `return null`. Сообщение при этом никуда не исчезало: в ленте
 * оставался пузырь со временем, галочками и контекстным меню — и совершенно
 * пустой внутри. Понять, что это была запись, было неоткуда; выглядело как
 * сбой отрисовки. Групповой пузырь на том же условии говорил словами
 * «🎤 Голосовое сообщение недоступно» — то есть правильное поведение в
 * приложении уже было написано, просто не в обеих половинах.
 *
 * Дефект второй. Плеер знал один отказ на всех: «Не загрузилось — нажмите» и
 * значок «повторить». Для чужой записи это верно — вложение лежит на relay,
 * сеть могла не ответить, повтор осмыслен. Для своей — нет: скачивать нечего,
 * file:// на устройстве не нашёлся (стёрли данные, система почистила кэш), и
 * нажимать «повторить» можно было бесконечно с одним и тем же исходом. Совет,
 * который нельзя выполнить, хуже молчания: он выдаёт потерю за заминку.
 *
 * Цена. В первом случае человек видит сообщение, о котором нельзя сказать
 * даже, чем оно было. Во втором — тратит попытки на то, что не сработает, и
 * не узнаёт, что запись потеряна.
 *
 * Правка. Текст «недоступно» стал одной экспортируемой строкой, и обе
 * половины берут её оттуда. У плеера появилась отдельная фаза `gone`: она не
 * предлагает повтора, не красится как ошибка сети и называет настоящую
 * причину.
 *
 * Проверяется исходник: ни пузырь, ни плеер в jest не поднимаются (expo-audio,
 * expo-file-system, контекст темы), а вся суть правки — в том, какая ветка что
 * рисует.
 */
import * as fs from 'fs';
import * as path from 'path';

const HERE = path.join(__dirname, '..');
const read = (...rel: string[]): string => fs.readFileSync(path.join(HERE, ...rel), 'utf8');

/** Код без комментариев: пояснение не должно подменять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const STRIP = (): string => codeOnly(read('MediaStrip.tsx'));
const VOICE = (): string => codeOnly(read('..', '..', 'components', 'VoiceMessage.tsx'));
const GROUPS = (): string => codeOnly(read('..', 'GroupsScreen.tsx'));

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники читаются и это те самые файлы', () => {
    expect(STRIP().length).toBeGreaterThan(2000);
    expect(VOICE().length).toBeGreaterThan(2000);
    expect(GROUPS().length).toBeGreaterThan(2000);
    expect(STRIP()).toContain('export function MediaStrip(');
    expect(VOICE()).toContain('export function VoicePlayer(');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('условие «ни адреса, ни вложения» в личном пузыре осталось на месте', () => {
    expect(STRIP()).toContain('if (!uri && !meta.blob)');
  });

  it('группа по-прежнему решает то же самое и тем же условием', () => {
    expect(GROUPS()).toContain('if (!voiceUri && !meta.blob) {');
  });

  it('у плеера остался тупик, где адрес так и не нашёлся', () => {
    expect(VOICE()).toContain('if (!playUri) {');
  });

  it('значок «повторить» никуда не делся — он нужен для настоящих сбоев сети', () => {
    expect(VOICE()).toContain("'refresh'");
    expect(VOICE()).toContain('Не загрузилось — нажмите');
  });
});

describe('пустого пузыря больше нет', () => {
  it('личная переписка на «недоступно» рисует текст, а не ничто', () => {
    const branch = slice(STRIP(), 'if (!uri && !meta.blob) {', 'return (\n      <VoicePlayer');
    expect(branch).not.toContain('return null');
    expect(branch).toContain('{VOICE_UNAVAILABLE_TEXT}');
  });

  it('обе половины берут одну строку, а не пишут свою', () => {
    expect(STRIP()).toContain("from '../../components/VoiceMessage'");
    expect(STRIP()).toContain('VOICE_UNAVAILABLE_TEXT');
    expect(GROUPS()).toContain('VOICE_UNAVAILABLE_TEXT');
  });

  it('сама строка живёт ровно в одном месте', () => {
    const holders = [STRIP(), GROUPS(), VOICE()].filter((src) => src.includes('Голосовое сообщение недоступно'));
    expect(holders).toHaveLength(1);
    expect(VOICE()).toContain("export const VOICE_UNAVAILABLE_TEXT = '🎤 Голосовое сообщение недоступно';");
  });

  it('кегль взят из шкалы: пузырь не заводит собственного числа', () => {
    const branch = slice(STRIP(), 'if (!uri && !meta.blob) {', 'return (\n      <VoicePlayer');
    expect(branch).toContain('fontSize: font.sm');
    expect(branch).not.toMatch(/fontSize: \d/);
  });
});

describe('повторять предлагают только там, где повтор что-то меняет', () => {
  it('у плеера есть отдельная фаза для потери без возврата', () => {
    expect(VOICE()).toContain("'idle' | 'downloading' | 'opening' | 'error' | 'gone'");
  });

  it('фазу выбирает наличие вложения, а не общий случай', () => {
    const dead = slice(VOICE(), 'if (!playUri) {', 'await setAudioModeAsync(');
    expect(dead).toContain("setPhase(blob ? 'error' : 'gone');");
    expect(dead).not.toContain("setPhase('error');");
  });

  it('в тупике без вложения кнопка перестаёт быть кнопкой', () => {
    expect(VOICE()).toContain("const gone = phase === 'gone';");
    expect(VOICE()).toContain('disabled={busy || gone}');
  });

  it('значок больше не обещает повтора там, где его нет', () => {
    const icon = slice(VOICE(), 'name={gone', '/>');
    expect(icon).toContain("gone ? 'alert-circle-outline'");
    expect(icon).toContain("failed ? 'refresh'");
  });

  it('подпись называет причину, а не зовёт нажимать', () => {
    expect(VOICE()).toContain("? 'Запись не найдена на устройстве'");
    const line = slice(VOICE(), 'accessibilityLabel={', '}\n      >');
    expect(line).toContain("gone ? 'Голосовое недоступно'");
    expect(line.indexOf('gone ?')).toBeLessThan(line.indexOf('Повторить загрузку голосового'));
  });

  it('потеря не красится как сбой сети: у них разный цвет', () => {
    expect(VOICE()).toContain('color={gone ? bubble.ink.muted : failed ? bubble.ink.error : accentColor}');
    expect(VOICE()).toContain('failed ? bubble.ink.error : gone ? bubble.ink.muted : bubble.ink.secondary');
  });
});

describe('поведение чужой записи не тронуто', () => {
  it('вложение по-прежнему скачивается и по-прежнему может дать «повторить»', () => {
    const dead = slice(VOICE(), 'if (!playUri && blob) {', 'if (!playUri) {');
    expect(dead).toContain("setPhase('downloading');");
    expect(dead).toContain("resolveBlobToLocalFile(blob, 'm4a')");
  });

  it('сбой при открытии плеера остался сбоем, а не потерей', () => {
    const fail = slice(VOICE(), '} catch {\n      if (createdPlayer) {', "setPhase('idle');");
    expect(fail).toContain("setPhase('error');");
    expect(fail).not.toContain("'gone'");
  });
});
