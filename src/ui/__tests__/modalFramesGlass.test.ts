/**
 * Окна поверх экрана: сколько у них рамок и что под ними видно (v4.32.604).
 *
 * Три жалобы с экрана, три проверки здесь:
 *  - лист «Новой публикации» уезжал верхом за кромку, когда открывалась
 *    клавиатура: высоту выбирал флаг `keyboardVisible`, а отступ снизу —
 *    KeyboardAvoidingView, и они расходились;
 *  - у окна с PIN-кодом рамок было три подряд — карточка, панель клавиатуры,
 *    кружки клавиш;
 *  - подложка окна была плоской плёнкой, приложение под ней читалось целиком.
 *
 * Проверяется исходник, а не отрисовка: все три решения — это форма разметки, и
 * ломаются они правкой разметки.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('лист «Новой публикации» и клавиатура', () => {
  const src = read('ui/screens/FeedScreen.tsx');

  /** Разметка листа: от контейнера клавиатуры до открывающего тега шапки. */
  const sheet = (): string => {
    const from = src.indexOf('<KeyboardAvoidingView');
    const to = src.indexOf('<View style={styles.modalTopBar}>', from);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return src.slice(from, to);
  };

  it('высота листа ограничена остатком контейнера, а не долей экрана', () => {
    expect(sheet()).toContain("maxHeight: '100%'");
  });

  it('высоту листа не выбирает флаг клавиатуры', () => {
    // Флаг остаётся — им выбирается только нижний отступ, где расхождение стоит
    // лишних 22 pt, а не уехавшей за кромку шапки.
    const branch = sheet();
    expect(branch).not.toContain("Platform.OS === 'ios' && !keyboardVisible");
    expect(branch).toContain('height: MODAL_HEIGHT_COLLAPSED');
  });

  it('чёлку вычитает контейнер, а не маржин листа', () => {
    expect(sheet()).toContain('{ paddingTop: insets.top + 8 }');
  });
});

describe('клавиатура PIN-кода', () => {
  const src = read('ui/components/PinPad.tsx');

  it('внутри окна панель без стекла и без рамки', () => {
    expect(src).toContain('const Keys = compact ? BareKeys : GlassKeys;');
    // У безрамочной обёртки не должно остаться стекла: иначе рамка вернётся.
    const bare = src.slice(src.indexOf('function BareKeys'));
    expect(bare.slice(0, bare.indexOf('}\n\n'))).not.toContain('GlassSurface');
  });

  it('на фоне приложения стекло остаётся', () => {
    const glassKeys = src.slice(src.indexOf('function GlassKeys'));
    expect(glassKeys.slice(0, 300)).toContain('<GlassSurface');
  });
});

describe('подложка окон в настройках', () => {
  const src = read('ui/screens/SettingsScreen.tsx');
  const lines = src.split('\n');

  it('под каждым окном фон размыт', () => {
    const opens = lines
      .map((l, i) => ({ l: l.trim(), i }))
      .filter(({ l }) => l.includes('styles.pwdModalBg') && l.endsWith('>') && !l.endsWith('/>'));
    expect(opens.length).toBeGreaterThanOrEqual(10);
    for (const { i } of opens) {
      expect([i + 1, lines[i + 1].trim()]).toEqual([i + 1, '<ModalScrimBlur />']);
    }
  });

  it('плёнка под размытием остаётся — контраст листа держит она', () => {
    expect(src).toContain('backgroundColor: scrim.modal');
  });
});

describe('размытие подложки', () => {
  const src = read('ui/components/ModalScrimBlur.tsx');

  it('уважает запрет на прозрачность', () => {
    expect(src).toContain('useReducedTransparency');
    expect(src).toContain('if (solid) return null;');
  });

  it('оттенок тёмный в обеих темах — подложка уводит фон от листа', () => {
    expect(src).toContain('tint="dark"');
  });

  it('не перехватывает касания мимо окна', () => {
    expect(src).toContain('pointerEvents="none"');
  });
});
