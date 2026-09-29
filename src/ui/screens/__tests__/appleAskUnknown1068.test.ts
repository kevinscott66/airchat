/**
 * Неспрошенный сервер выдавался за «входа через Apple ID нет» (v4.32.1068).
 *
 * ДЕФЕКТ. `listSeedBindingProviders` отвечал пустым списком на всё сразу:
 * сервер сказал «входы выключены», сервер промолчал до истечения срока,
 * ответ не разобрался, запрос бросил. Пустой список — утверждение, и оба
 * экрана читали его именно так.
 *
 * ЦЕНА. Экран восстановления рисует по этому списку кнопку «Войти через Apple
 * ID». Не спросив сервер, он её просто не рисовал и ничего не говорил.
 * Человек, у которого секретные слова лежат только в конверте на сервере,
 * видит при этом единственный путь — «введите секретные слова, 24 слова», —
 * которых у него нет. Вывод один: аккаунт не вернуть. А сервер, возможно,
 * просто не ответил на один запрос.
 *
 * В настройках цена другая, но того же рода: строка привязки исчезала
 * целиком, включая «Слова привязаны к Apple ID» у тех, у кого привязка есть,
 * и «Нажмите, чтобы отвязать» вместе с ней.
 *
 * ПРАВКА. Чтение отвечает `null`, когда спросить не вышло. Кнопку по-прежнему
 * рисуем только при живом входе — мёртвая кнопка хуже отсутствующей, она
 * обещает и не делает (политика не пересматривается). Вместо неё на этот
 * случай встают слова: сервер не ответил, привязка от этого никуда не делась,
 * и на экране восстановления рядом стоит «Повторить».
 *
 * ГРАНИЦЫ. Пустой список после ответа сервера — по-прежнему «входа нет», без
 * единого слова. Сборка без облака (веб) — тоже твёрдый ответ, а не
 * неизвестность: спрашивать некого (v4.32.596). Устройство без
 * `expo-apple-authentication` как молчало, так и молчит — там входа нет и с
 * сервером это не связано.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  appleAskState,
  APPLE_ASK_RETRY,
  APPLE_ASK_UNKNOWN_RESTORE,
  APPLE_ASK_UNKNOWN_SETTINGS,
  APPLE_ASK_UNKNOWN_TITLE,
} from '../../utils/appleAskState';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const read = (...rel: string[]): string =>
  codeOnly(readFileSync(join(__dirname, '..', '..', '..', ...rel), 'utf8'));

const ONBOARDING = (): string => read('ui', 'screens', 'OnboardingScreen.tsx');
const SETTINGS = (): string => read('ui', 'screens', 'SettingsScreen.tsx');
const CORE = (): string => read('core', 'backup', 'seedBinding.ts');

describe('спросили или нет', () => {
  it('вход есть — рисуем кнопку', () => {
    expect(appleAskState(['apple'])).toBe('ready');
    expect(appleAskState(['google', 'apple'])).toBe('ready');
  });

  it('сервер ответил «нет» — кнопки нет, и говорить нечего', () => {
    expect(appleAskState([])).toBe('off');
    expect(appleAskState(['google'])).toBe('off');
  });

  it('спросить не вышло — это не «нет»', () => {
    // Та самая развилка: пустое место на экране читается как «такого входа
    // здесь не бывает», а мы всего лишь не получили ответа.
    expect(appleAskState(null)).toBe('unknown');
  });
});

describe('слова вместо кнопки', () => {
  it('сказано, что это не отсутствие привязки', () => {
    expect(APPLE_ASK_UNKNOWN_TITLE).toContain('не ответил');
    expect(APPLE_ASK_UNKNOWN_RESTORE).toContain('Это не значит, что привязки нет');
    expect(APPLE_ASK_UNKNOWN_RESTORE).toContain(APPLE_ASK_RETRY);
  });

  it('в настройках сказано, что привязка никуда не делась', () => {
    expect(APPLE_ASK_UNKNOWN_SETTINGS).toContain('появится, когда сервер ответит');
    expect(APPLE_ASK_UNKNOWN_SETTINGS).toContain('никуда не делась');
  });
});

describe('форма исходника: чтение', () => {
  it('ответов у чтения два, и «не спросили» отдельный', () => {
    const s = CORE();
    expect(s).toContain(
      'export async function trySeedBindingProviders(): Promise<SeedBindingProvider[] | null> {',
    );
    expect(s).toContain('if (!providers) return null;');
    expect(s).toContain('  } catch {\n    return null;\n  }');
  });

  it('ГРАНИЦА: сборка без облака отвечает «входов нет», а не «не спросили»', () => {
    const s = CORE();
    const at = s.indexOf('export async function trySeedBindingProviders(');
    expect(s.slice(at, at + 260)).toContain('if (!base) return [];');
  });

  it('собирающей формы рядом не осталось', () => {
    expect(CORE()).not.toContain('export async function listSeedBindingProviders');
  });
});

describe('форма исходника: экран восстановления', () => {
  it('состояние трёхзначное и приходит из правила', () => {
    const s = ONBOARDING();
    expect(s).toContain("const [appleAsk, setAppleAsk] = useState<AppleAskState>('off');");
    expect(s).toContain('const providers = await trySeedBindingProviders();');
    expect(s).toContain('setAppleAsk(appleAskState(providers));');
    expect(s).toContain("const appleReady = appleAsk === 'ready';");
  });

  it('слова стоят на обоих экранах, где стояла бы кнопка', () => {
    const s = ONBOARDING();
    expect(s).toContain("{appleAsk === 'unknown' ? appleAskNote('welcome_apple_unknown') : null}");
    expect(s).toContain("appleAskNote('restore_apple_unknown')");
  });

  it('повторить можно, не уходя с экрана', () => {
    const s = ONBOARDING();
    expect(s).toContain('const [appleAskTick, setAppleAskTick] = useState(0);');
    expect(s).toContain('setAppleAskTick((t) => t + 1)');
    // Эффект обязан подниматься заново, иначе кнопка «Повторить» ничего не
    // повторяет.
    expect(s).toContain('  }, [appleAskTick]);');
  });

  it('кнопка по-прежнему рисуется только при живом входе', () => {
    // Политика v4.32.596 не пересматривается: мёртвая кнопка хуже
    // отсутствующей. Правка добавляет слова, а не кнопку.
    const s = ONBOARDING();
    expect(s).toContain('{appleReady ? (');
    expect(s).toContain('{appleReady && !appleBinding && !isBackupPaste ? (');
  });
});

describe('форма исходника: настройки', () => {
  it('отдельное состояние и строка вместо исчезновения', () => {
    const s = SETTINGS();
    expect(s).toContain('const [appleBindUnknown, setAppleBindUnknown] = useState(false);');
    expect(s).toContain("setAppleBindUnknown(ask === 'unknown');");
    expect(s).toContain('testID="settings_bind_apple_unknown"');
  });

  it('строка показана янтарём и нажимать её нечего', () => {
    const s = SETTINGS();
    const at = s.indexOf('testID="settings_bind_apple_unknown"');
    expect(at).toBeGreaterThan(0);
    const block = s.slice(at, at + 420);
    expect(block).toContain('colors.warning');
    expect(block).not.toContain('onPress');
  });

  it('прежняя строка остаётся единственной, когда вход подтверждён', () => {
    const s = SETTINGS();
    expect(s).toContain('{appleBindUnknown && !appleBindReady && hasAppPassword ? (');
    expect(s).toContain("if (ask === 'ready') setAppleBindReady(true);");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежнее поведение цело', () => {
  it('устройство без Apple ID молчит, как молчало', () => {
    const s = ONBOARDING();
    expect(s).toContain('if (!(await isAppleSignInAvailable())) return;');
  });

  it('вход через Apple ID на экране восстановления работает как работал', () => {
    const s = ONBOARDING();
    expect(s).toContain("const envelope = await fetchSeedBinding('apple', identity.idToken);");
    expect(s).toContain('К этому Apple ID секретные слова не привязаны');
  });

  it('строка привязки в настройках на месте', () => {
    const s = SETTINGS();
    expect(s).toContain('testID="settings_bind_apple"');
    expect(s).toContain('Слова привязаны к Apple ID');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сервер и правда умеет промолчать: у запроса есть срок', () => {
    const s = CORE();
    expect(s).toContain('timeoutMs: SEED_BINDING_TIMEOUT_MS');
    expect(s).toContain('/v1/seed-binding/providers');
  });

  it('от списка по-прежнему зависит именно кнопка входа', () => {
    const s = ONBOARDING();
    expect(s).toContain('testID="btn_welcome_apple"');
    expect(s).toContain('testID="btn_restore_apple"');
  });

  it('другого пути к словам на этом экране нет', () => {
    // Ради этого всё: кроме конверта с сервера человеку предлагают только
    // ввести 24 слова руками.
    expect(ONBOARDING()).toContain('Секретные слова или резервная копия');
  });
});

describe('ЗАКРЕПКА', () => {
  it('правило лежит отдельно от экранов и без импортов', () => {
    const rule = readFileSync(join(__dirname, '..', '..', 'utils', 'appleAskState.ts'), 'utf8');
    expect(codeOnly(rule)).not.toContain('import ');
  });
});
