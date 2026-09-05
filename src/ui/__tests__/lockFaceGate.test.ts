/**
 * Замок: пока работает Face ID, клавиатуры на экране нет (v4.32.598).
 *
 * Лицо и шесть цифр — два разных способа войти, и показывать оба разом значит
 * звать набирать код там, где набирать нечего: человек смотрит в экран, а под
 * системным запросом уже нарисованы клавиши. Здесь проверяется, что знак лица
 * стоит НА МЕСТЕ клавиатуры, а не рядом с ней, и что дорога к клавиатуре не
 * потеряна: Face ID отказал, отменили или его не включали — клавиши на месте,
 * и есть явная кнопка перейти к ним самому.
 *
 * Проверка по исходнику: `expo-secure-store` в тестовой среде подменён,
 * системного запроса в дереве не будет, и рендер о выборе ветки не скажет.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');
const src = readFileSync(join(SRC, 'ui/screens/PasswordScreen.tsx'), 'utf8');

/** Кусок разметки от первой ветки до закрывающего её Animated.View. */
function pad(): string {
  const at = src.indexOf('<Animated.View style={[styles.shakeWrap');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('</Animated.View>', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

describe('чем открывают замок', () => {
  it('вид выбирается одним состоянием, а не догадкой по флагу', () => {
    expect(src).toContain("useState<'checking' | 'face' | 'pin'>('checking')");
  });

  it('клавиатура стоит ПОСЛЕ лица, то есть вместо него, а не вместе с ним', () => {
    const markup = pad();
    const face = markup.indexOf("unlockBy === 'face' ?");
    const keys = markup.indexOf('<PinPad');
    expect(face).toBeGreaterThan(-1);
    expect(keys).toBeGreaterThan(face);
    // Между ветками — ровно одно ветвление, а не два соседних блока.
    expect(markup.slice(face, keys)).toContain('usePinMode ? (');
  });

  it('пока признак читается, не мигает ни лицом, ни клавишами', () => {
    expect(src).toContain("unlockBy === 'checking' ? (");
    const at = src.indexOf("unlockBy === 'checking' ? (");
    const spinner = src.indexOf('<ActivityIndicator', at);
    const branch = src.indexOf(') : (', at);
    // В ветке ожидания — только индикатор.
    expect(spinner).toBeGreaterThan(at);
    expect(spinner).toBeLessThan(branch);
  });

  it('знак лица — картинка во весь круг, и по ней можно позвать запрос ещё раз', () => {
    const markup = pad();
    expect(markup).toContain('name={Platform.OS === \'ios\' ? \'face-recognition\' : \'fingerprint\'}');
    expect(markup).toContain('size={FACE_GLYPH}');
    expect(markup).toContain('onPress={() => void handleBiometric()}');
  });

  it('отказ и отмена возвращают клавиатуру, а не запирают на лице', () => {
    // Один автоматический запрос на открытие экрана — и его исход решает вид.
    expect(src).toContain('const opened = await handleBiometricRef.current();');
    expect(src).toContain("if (!cancelled && !opened) setUnlockBy('pin');");
    // Биометрии нет — клавиатура сразу.
    expect(src).toContain('if (!enabled) {');
  });

  /**
   * v4.32.599: пад вставал поверх удавшегося Face ID. `onSuccess` приходит из
   * `App` новой стрелкой на каждую его перерисовку, `submitValue` и
   * `handleBiometric` пересоздавались следом, и эффект перезапускался посреди
   * проверки пароля: запрос уже был — значит клавиатура. Лечится тем, что
   * эффект больше ни от чего не зависит, а свежий обработчик берётся из ref.
   */
  it('запрос лица не перезапускается от перерисовки родителя', () => {
    const effect = src.slice(
      src.indexOf('  // Ровно один раз на открытие экрана'),
      src.indexOf('const handlePinKey')
    );
    expect(effect).toContain('}, []);');
    expect(effect).not.toContain('handleBiometric()');
    // Повторный проход эффекта не сбивает уже выбранный вид.
    expect(effect).toContain("setUnlockBy((v) => (v === 'checking' ? 'pin' : v));");
    // Ref обновляется отдельным эффектом, а не присваиванием в теле компонента.
    expect(src).toContain('const handleBiometricRef = useRef(handleBiometric);');
  });

  it('к клавиатуре есть дорога и без отказа на запросе', () => {
    expect(src).toContain("onPress={() => setUnlockBy('pin')}");
    expect(src).toContain('<Text style={styles.forgotLink}>Ввести код</Text>');
  });

  it('исход проверки пароля возвращается наверх, иначе решать было бы не по чему', () => {
    expect(src).toContain('async (value: string): Promise<boolean> =>');
    expect(src).toContain('const handleBiometric = useCallback(async (): Promise<boolean> => {');
  });
});

describe('проверка не пустая', () => {
  /** Разметка, какой она была до 598-го: клавиатура рисовалась всегда. */
  const BEFORE = '{usePinMode ? (\n              <PinPad';

  it('прежняя безусловная клавиатура была бы поймана', () => {
    expect(src).not.toContain(BEFORE);
    const markup = pad();
    expect(markup.indexOf('<PinPad')).toBeGreaterThan(markup.indexOf("unlockBy === 'face' ?"));
  });

  it('знак лица не подменён значком при клавиатуре', () => {
    // Клавиша Face ID в углу клавиатуры осталась, но она НЕ считается за вид
    // «лицо»: у неё другой значок и другое место.
    const pinpad = readFileSync(join(SRC, 'ui/components/PinPad.tsx'), 'utf8');
    expect(pinpad).not.toContain('face-recognition');
    expect(pinpad).toContain('PIN_BIOMETRIC');
  });
});
