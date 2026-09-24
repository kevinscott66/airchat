/**
 * Три жалобы с экрана, три правки (v4.32.848).
 *
 * 1. «Язык перевода» нельзя было прочитать. Плашки языков стоят в
 *    переносящейся строке (`flexWrap: 'wrap'`), а стиль им достался от кнопок
 *    выбора темы, где `flex: 1` делит ширину строки на три равные доли. В
 *    переносящейся строке то же объявление значит другое: вместе с `flex`
 *    приходит `flexBasis: 0` — «своей ширины у меня нет», — и двенадцать
 *    плашек ужимаются до ширины одной буквы. Подпись после этого печатается
 *    столбиком по букве на строку: «Русский» читался как Р-у-с-с-к-и-й.
 *
 * 2. Вход через Apple ID был только внутри «Восстановить аккаунт». Человеку с
 *    привязкой на первом экране предлагались два действия, и оба неверных:
 *    «создать новый» стирает аккаунт, «восстановить» просит 24 слова, которые
 *    он привязал ровно затем, чтобы их не вводить.
 *
 * 3. «Обход блокировок» объяснял себя через «документ Яндекса». Выбрать это
 *    слово ничему не помогает — настраивать там нечего, — зато называет вслух
 *    ту деталь, от знания которой обход и перестаёт работать.
 *
 * Проверяется форма исходников и сам объект стилей: всё три — решения о
 * разметке и словах, и ломаются они правкой разметки и слов.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { makeStyles } from '../screens/settings/settingsStyles';
import { lightColors } from '../theme';

const SRC = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

const styles = makeStyles(lightColors, (n) => n);

/**
 * Проверяется ОТСУТСТВИЕ свойства, а его в выведенном типе стиля нет вовсе —
 * `styles.langBtn.flex` для tsc ошибка, а не `undefined`. Поэтому смотрим на
 * стиль как на набор объявлений: спрашивать «есть ли flex» иначе нечем.
 */
const decls = (style: object): Record<string, unknown> => style as Record<string, unknown>;

describe('язык перевода: плашка шириной со слово', () => {
  it('плашка языка не делит ширину строки', () => {
    // Ни `flex`, ни `flexBasis`: ширина берётся по содержимому. Именно эти два
    // объявления и ужимали плашку до буквы.
    expect(decls(styles.langBtn).flex).toBeUndefined();
    expect(decls(styles.langBtn).flexBasis).toBeUndefined();
    expect(decls(styles.langBtn).flexGrow).toBeUndefined();
  });

  it('у плашки есть боковые поля — иначе слово упирается в рамку', () => {
    expect(styles.langBtn.paddingHorizontal).toBeGreaterThanOrEqual(10);
  });

  it('кнопка выбора темы своё «flex: 1» сохраняет: там строка из трёх', () => {
    expect(styles.themeBtn.flex).toBe(1);
  });

  it('экран выбирает язык плашкой, а не кнопкой темы', () => {
    const screen = read('ui/screens/SettingsScreen.tsx');
    const from = screen.indexOf("<SubHeader title=\"Язык перевода\" />");
    expect(from).toBeGreaterThan(0);
    const block = screen.slice(from, screen.indexOf('renderModals', from));

    expect(block).toContain("flexWrap: 'wrap'");
    expect(block).toContain('styles.langBtn');
    expect(block).not.toContain('styles.themeBtn,');
    // Подпись языка не переносится по буквам ни при каком кегле.
    expect(block).toContain('numberOfLines={1}');
  });
});

describe('вход через Apple ID предлагается на первом экране', () => {
  const src = read('ui/screens/OnboardingScreen.tsx');
  const welcome = (): string => {
    const from = src.indexOf("if (step === 'welcome') {");
    const to = src.indexOf("if (step === 'restore') {", from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return src.slice(from, to);
  };

  it('кнопка стоит в приветствии, а не только за «Восстановить»', () => {
    expect(welcome()).toContain('testID="btn_welcome_apple"');
    expect(welcome()).toContain('Войти через Apple ID');
  });

  it('её показывают только там, где вход через Apple действительно есть', () => {
    // Мёртвая кнопка хуже отсутствующей: `appleReady` ставится, лишь когда
    // вход доступен и на телефоне, и на сервере.
    expect(welcome()).toContain('{appleReady ? (');
  });

  it('человек попадает на экран, где может ввести слова руками', () => {
    // Порядок именно такой: сначала переход, потом окно Apple. Отказ Apple или
    // отсутствие привязки не выбрасывают обратно в приветствие.
    expect(src).toContain("    setStep('restore');\n    void handleAppleRestore();");
  });

  it('прежняя кнопка на экране восстановления осталась на месте', () => {
    expect(src).toContain('testID="btn_restore_apple"');
  });
});

describe('обход блокировок объясняется без внутренностей', () => {
  const src = read('ui/components/OpenFluxSettingsSection.tsx');
  /** Всё, что человек видит глазами: разметка секции. */
  const markup = (): string => {
    const from = src.indexOf('  return (\n    <View>');
    expect(from).toBeGreaterThan(0);
    return src.slice(from);
  };

  it('ни разметка, ни сообщения не называют, через что идёт трафик', () => {
    expect(markup()).not.toMatch(/документ/i);
    expect(markup()).not.toMatch(/яндекс/i);
    expect(src).not.toContain("showSuccess('Канал через документ поднят')");
    expect(src).not.toContain("showError('Снова не вышло. Проверьте документ и сеть')");
  });

  it('переключатель назван тем, что он делает для человека', () => {
    expect(markup()).toContain('Вести трафик в обход ограничений');
  });

  it('объяснение осталось объяснением, а не исчезло вместе с деталью', () => {
    // Убрать слово «документ» можно было и вычеркнув абзац целиком — тогда
    // человек остался бы с переключателем без единого слова о том, зачем он.
    expect(markup()).toContain('Когда оператор пускает только разрешённые сайты');
    expect(markup()).toContain('В обычной сети туннель можно выключить: без него быстрее.');
  });

  it('совет при неудаче показывает на то, что человек может проверить', () => {
    expect(src).toContain("showError('Не удалось поднять канал. Проверьте подключение к сети')");
    expect(src).toContain("showError('Снова не вышло. Проверьте подключение к сети')");
  });
});
