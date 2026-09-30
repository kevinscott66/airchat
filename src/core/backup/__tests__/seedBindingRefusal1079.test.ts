/**
 * ДЕФЕКТ (v4.32.1079). Вход по привязке к Apple ID на любой отказ отвечал
 * «Неверный пароль приложения.»
 *
 * `decryptSeedBinding` возвращала `null` в семи местах: конверта нет; версия
 * конверта не эта; `acceptKdfIters` отверг число итераций (занижено ради
 * дешёвого перебора или задрано до зависания); `saltB64`/`dataB64` не строки;
 * шифртекст длиннее предела; соль не той длины; `decryptSymmetric` не сошёлся
 * на метке; расшифрованное не прошло `validateMnemonic`. Экран (
 * handleRestoreFromBinding) сводил все семь к одной подписи, и подпись эта
 * называла виноватым пароль.
 *
 * ЦЕНА. Сюда приходят те, у кого двадцати четырёх слов на руках нет — конверт
 * на сервере и есть единственная дорога домой. Пароль приложения у человека
 * один. Услышав «неверный пароль», он вводит тот же пароль ещё раз, потом
 * решает, что забыл его, и заводит новый аккаунт — с новым DID, без переписки
 * и без @имени. Конверт при этом цел, а настоящая причина у половины случаев
 * чинится сама: конверт, сохранённый более новой сборкой, откроется после
 * обновления приложения. Тело конверта приходит с сервера без единой
 * проверки формы (fetchSeedBinding приводит `body.envelope` к типу и всё),
 * так что «порченая запись» — не теоретический случай.
 *
 * ПРАВКА. `openSeedBinding` отвечает исходом: `{ ok: true, mnemonic }` или
 * `{ ok: false, why }`, где `why` — один из пяти разрядов. Подписи живут
 * отдельным модулем без единого импорта (seedBindingRefusal), экран берёт
 * текст по разряду.
 *
 * ГРАНИЦЫ. Настоящий неверный пароль отвечает прежними словами, буква в
 * букву: правка не про то, чтобы говорить иначе, а про то, чтобы не говорить
 * этого там, где оно неправда. Новых сведений о пароле наружу не выходит:
 * различить «не тот пароль» и «внутри не слова» может лишь тот, у кого метка
 * AEAD уже сошлась, то есть кто пароль ввёл верно.
 */
import fs from 'fs';
import path from 'path';

import {
  SEED_BINDING_KDF_ITERS,
  SEED_BINDING_VERSION,
  encryptSeedBinding,
  openSeedBinding,
  type SeedBindingEnvelope,
} from '../seedBinding';
import {
  seedBindingRefusalText,
  type SeedBindingRefusal,
} from '../seedBindingRefusal';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'пароль-приложения';

/** PBKDF2 здесь настоящий (600 000 итераций ≈ секунда) — конверт считаем один раз. */
jest.setTimeout(30_000);

let envelope: SeedBindingEnvelope;

beforeAll(() => {
  envelope = encryptSeedBinding(MNEMONIC, PASSWORD, 1_700_000_000_000);
});

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

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

const SCREEN = () => read('ui', 'screens', 'OnboardingScreen.tsx');
const CORE = () => read('core', 'backup', 'seedBinding.ts');

const why = (env: unknown): SeedBindingRefusal | 'открылся' => {
  const out = openSeedBinding(env as SeedBindingEnvelope, PASSWORD);
  return out.ok ? 'открылся' : out.why;
};

describe('отказ называет себя', () => {
  it('верный пароль открывает конверт', () => {
    expect(openSeedBinding(envelope, PASSWORD)).toEqual({ ok: true, mnemonic: MNEMONIC });
  });

  it('пароль виноват только там, где не сошлась метка', () => {
    expect(openSeedBinding(envelope, 'пароль-приложенья')).toEqual({
      ok: false,
      why: 'wrong_password',
    });
  });

  it('конверт новее — свой разряд, а не пароль', () => {
    expect(why({ ...envelope, v: SEED_BINDING_VERSION + 1 })).toBe('newer_envelope');
    expect(why({ ...envelope, v: SEED_BINDING_VERSION + 7 })).toBe('newer_envelope');
  });

  it('версия не число и версия старее — порченая запись, но не «новее»', () => {
    expect(why({ ...envelope, v: 'один' })).toBe('broken_envelope');
    expect(why({ ...envelope, v: SEED_BINDING_VERSION - 1 })).toBe('broken_envelope');
    expect(why({ ...envelope, v: Number.NaN })).toBe('broken_envelope');
  });

  it('форма конверта: итерации, соль, поля, длина — всё «порченая запись»', () => {
    expect(why({ ...envelope, iters: SEED_BINDING_KDF_ITERS - 1 })).toBe('broken_envelope');
    expect(why({ ...envelope, iters: 1e15 })).toBe('broken_envelope');
    expect(why({ ...envelope, saltB64: 'AAEC' })).toBe('broken_envelope');
    expect(why({ ...envelope, saltB64: 42 })).toBe('broken_envelope');
    expect(why({ ...envelope, dataB64: null })).toBe('broken_envelope');
    expect(why({ ...envelope, dataB64: 'A'.repeat(5000) })).toBe('broken_envelope');
  });

  it('конверта нет — это не пароль и не порча', () => {
    expect(why(null)).toBe('no_envelope');
    expect(why(undefined)).toBe('no_envelope');
  });

  it('пять разрядов — пять разных подписей, и все непустые', () => {
    const all: SeedBindingRefusal[] = [
      'no_envelope',
      'newer_envelope',
      'broken_envelope',
      'wrong_password',
      'broken_words',
    ];
    const texts = all.map(seedBindingRefusalText);
    texts.forEach((t) => expect(t.length).toBeGreaterThan(10));
    expect(new Set(texts).size).toBe(all.length);
  });

  it('ГРАНИЦА: настоящий неверный пароль говорит ровно прежними словами', () => {
    expect(seedBindingRefusalText('wrong_password')).toBe('Неверный пароль приложения.');
  });

  it('ГРАНИЦА: про пароль не говорит никто, кроме разряда пароля', () => {
    for (const w of ['no_envelope', 'newer_envelope', 'broken_envelope'] as const) {
      expect(seedBindingRefusalText(w)).not.toContain('Неверный пароль');
    }
    // У испорченных слов пароль как раз подошёл — об этом и сказано.
    expect(seedBindingRefusalText('broken_words')).toContain('Пароль подошёл');
  });

  it('ГРАНИЦА: подпись «новее» ведёт к обновлению, а не к новой попытке пароля', () => {
    expect(seedBindingRefusalText('newer_envelope')).toContain('Обновите приложение');
  });
});

describe('форма правки', () => {
  it('экран берёт исход и подпись по разряду', () => {
    const body = slice(
      codeOnly(SCREEN()),
      'const handleRestoreFromBinding',
      'const confirmKeysOnly',
    );
    expect(body).toContain('const opened = openSeedBinding(appleBinding, cloudPwd);');
    expect(body).toContain('if (!opened.ok) {');
    expect(body).toContain("Alert.alert('AirChat', seedBindingRefusalText(opened.why));");
    expect(body).toContain('const mnemonic = opened.mnemonic;');
  });

  it('единственной подписи на все случаи в экране больше нет', () => {
    expect(codeOnly(SCREEN())).not.toContain("'Неверный пароль приложения.'");
    expect(codeOnly(SCREEN())).not.toContain('decryptSeedBinding');
  });

  it('разбор причин живёт в ядре, а слова — в модуле без импортов', () => {
    const core = codeOnly(CORE());
    for (const w of [
      "no('no_envelope')",
      "no('newer_envelope')",
      "no('broken_envelope')",
      "no('wrong_password')",
      "no('broken_words')",
    ]) {
      expect(core).toContain(w);
    }
    // Слова экрана не должны тянуть за собой ни криптографию, ни сеть:
    // модуль подписей читается и проверяется сам по себе.
    expect(read('core', 'backup', 'seedBindingRefusal.ts')).not.toContain('\nimport ');
  });

  it('ветка «внутри не слова» стоит после проверки слов, а не до неё', () => {
    // Подделать такой конверт снаружи нельзя: ключ выводится приватной
    // формой, а AAD не вывешен наружу — и вывешивать их ради теста нельзя.
    // Поэтому здесь закрепляется порядок в исходнике.
    const body = slice(codeOnly(CORE()), 'export function openSeedBinding', '\n}\n');
    const pwd = body.indexOf("no('wrong_password')");
    const words = body.indexOf("no('broken_words')");
    expect(pwd).toBeGreaterThan(0);
    expect(words).toBeGreaterThan(pwd);
    expect(body.indexOf('validateMnemonic(mnemonic)')).toBeLessThan(words);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние правила входа целы', () => {
  it('отсутствие привязки по-прежнему ловится раньше и своими словами', () => {
    expect(SCREEN()).toContain(
      "'К этому Apple ID секретные слова не привязаны. Введите их вручную.'",
    );
  });

  it('открытые слова по-прежнему уезжают в восстановление аккаунта', () => {
    const body = slice(
      codeOnly(SCREEN()),
      'const handleRestoreFromBinding',
      'const confirmKeysOnly',
    );
    expect(body).toContain('await restoreFromMnemonic(mnemonic)');
    expect(body).toContain('await restoreCloudVault(mnemonic, cloudPwd)');
  });

  it('заниженный KDF по-прежнему отвергается ДО счёта ключа', () => {
    // Иначе конверт с `iters: 1` заставил бы нас считать по нему ключ —
    // ровно то удешевление перебора, ради которого планку и ставили.
    const body = slice(codeOnly(CORE()), 'export function openSeedBinding', '\n}\n');
    expect(body.indexOf('acceptKdfIters(')).toBeLessThan(body.indexOf('deriveBindingKey('));
  });

  it('конверт по-прежнему шифруется как прежде и не выдаёт слов', () => {
    expect(envelope.v).toBe(SEED_BINDING_VERSION);
    expect(envelope.iters).toBe(SEED_BINDING_KDF_ITERS);
    expect(envelope.dataB64).not.toContain('abandon');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('отказы по-прежнему неотличимы, если смотреть только на «не открылось»', () => {
    // Так выглядел прежний ответ: у всех четырёх один и тот же null.
    const cases = [
      null,
      { ...envelope, v: SEED_BINDING_VERSION + 1 },
      { ...envelope, saltB64: 'AAEC' },
      { ...envelope, iters: 1 },
    ];
    const opened = cases.map((c) => openSeedBinding(c as SeedBindingEnvelope, PASSWORD));
    expect(opened.every((o) => !o.ok)).toBe(true);
    // А так — после правки: разрядов несколько, и подписи у них разные.
    const whys = opened.map((o) => (o.ok ? 'открылся' : o.why));
    expect(new Set(whys).size).toBeGreaterThanOrEqual(3);
    const texts = whys.map((w) => seedBindingRefusalText(w as SeedBindingRefusal));
    expect(new Set(texts).size).toBeGreaterThanOrEqual(3);
  });

  it('сервер и правда отдаёт конверт без проверки формы', () => {
    // Если бы fetchSeedBinding конверт разбирал, «порченая запись» была бы
    // выдумкой. Она не выдумка: тело ответа приводится к типу и отдаётся.
    expect(codeOnly(CORE())).toContain(
      'const body = (await response.json()) as { envelope?: SeedBindingEnvelope };',
    );
  });
});
