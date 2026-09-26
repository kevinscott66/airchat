/**
 * Экран настроек показывал значения по умолчанию, когда настройки не читались
 * (v4.32.1000).
 *
 * Дефект. Двадцать пять чтений на старте экрана шли через гасящие формы —
 * `kvGet`, `privacyPrefGet`, `ownFieldGet`, `scopedKvGet`,
 * `cloudTranslateAllowed`, `getDefaultDisappearMs`. Каждая ловит ошибку базы
 * у себя и отдаёт `null` — тот же ответ, что и «запись не трогали». Написанный
 * тут же `catch` с честной надписью «Настройки не прочитались» ждал отказа,
 * которого ни одна из двадцати пяти форм не умеет дать: с версии, где его
 * написали, он не исполнялся ни разу.
 *
 * Цена. `null` раскрывается в разрешающую сторону: `nDm !== 'false'` —
 * «уведомления включены», `dndEn === 'true'` — «не беспокоить выключено»,
 * `disableRr === 'true'` — «отметки о прочтении уходят». Это ровно
 * противоположно тому, что лежит в базе у человека, который ночное молчание
 * включил, а отметки выключил. Он читает с экрана не своё решение, а
 * умолчание — и либо верит ему, либо правит тумблер, целясь не туда.
 *
 * Правка. Чтения идут тремя состояниями (`kvTryGet` и родня), непрочитанная
 * запись отказывает на месте, и отказ доезжает до того самого `catch`. Для
 * двух чтений, у которых трёхсостоянийной формы не было, она заведена:
 * `cloudTranslateAllowedRead` и `getDefaultDisappearMsReadFor`.
 *
 * Границы. Короткие гасящие формы остаются: местам, которые по значению
 * действуют, а не показывают его, довольно одного `null`. Проверяется только
 * экран настроек и две новые формы.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..');
const read = (...rel: string[]): string => fs.readFileSync(path.join(SRC, ...rel), 'utf8');

const SCREEN = read('ui', 'screens', 'SettingsScreen.tsx');
const LOCAL = read('core', 'storage', 'local.ts');
const SCOPED = read('core', 'storage', 'profileScopedKv.ts');
const OWN = read('core', 'identity', 'ownProfile.ts');
const CONSENT = read('core', 'social', 'translateConsent.ts');
const DISAPPEAR = read('core', 'storage', 'defaultDisappear.ts');

/** Пояснение в комментарии не должно засчитываться за код. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/** Кусок между двумя опорами — чтобы совпадение не пришло от соседа. */
function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** Тот самый эффект: чтение настроек на открытии экрана. */
const EFFECT = codeOnly(slice(SCREEN, 'let cancelled = false;', '}, [profileRefreshToken]);'));

describe('настройки: непрочитанная запись не выдаётся за «не трогали»', () => {
  it('все двадцать пять чтений идут тремя состояниями, а не гасящими формами', () => {
    expect(EFFECT).toContain('kvRead(');
    expect(EFFECT).toContain('prefRead(');
    expect(EFFECT).toContain('ownRead(');
    expect(EFFECT).toContain('scopedRead(');
    // Гасящие формы из пачки ушли целиком.
    expect(EFFECT).not.toContain('kvGet(');
    expect(EFFECT).not.toContain('privacyPrefGet(');
    expect(EFFECT).not.toContain('ownFieldGet(');
    expect(EFFECT).not.toContain('scopedKvGet(');
  });

  it('непрочитанная запись отказывает на месте, а не доезжает до setter’а', () => {
    const helpers = codeOnly(slice(SCREEN, 'const unreadable = (key: string)', 'void Promise.all(['));
    expect(helpers).toContain('throw new Error(`settings_unreadable:${key}`)');
    for (const [fn, source] of [
      ['kvRead', 'kvTryGet(key)'],
      ['prefRead', 'privacyPrefTryGet(key)'],
      ['ownRead', 'ownFieldTryGet(key)'],
      ['scopedRead', 'scopedKvTryGet(key)'],
    ] as const) {
      expect(helpers).toContain(`const ${fn} = async (`);
      expect(helpers).toContain(`await ${source}`);
    }
    // Каждая из четырёх отвечает отказом ровно на null.
    expect(helpers.match(/got === null \? unreadable\(key\)/g)).toHaveLength(4);
  });

  it('два чтения без короткой формы тоже отказывают', () => {
    expect(EFFECT).toContain("cloudTranslateAllowedRead().then((v) => (v === null ? unreadable('cloud_translate') : v))");
    expect(EFFECT).toContain("getDefaultDisappearMsRead().then((v) => (v === null ? unreadable('default_auto_delete') : v.ms))");
    expect(EFFECT).not.toContain('cloudTranslateAllowed()');
    expect(EFFECT).not.toContain('getDefaultDisappearMs()');
  });

  it('гасящие формы больше не ввозятся в экран под старыми именами', () => {
    const imports = codeOnly(SCREEN.slice(0, SCREEN.indexOf('export ')));
    expect(imports).toContain('kvTryGet');
    expect(imports).toContain('privacyPrefTryGet');
    expect(imports).toContain('ownFieldTryGet');
    expect(imports).toContain('scopedKvTryGet');
    expect(imports).toContain('cloudTranslateAllowedRead');
    expect(imports).toContain('getDefaultDisappearMsRead');
    expect(imports).not.toMatch(/\bkvGet\b/);
    expect(imports).not.toMatch(/\bprivacyPrefGet\b/);
    expect(imports).not.toMatch(/\bownFieldGet\b/);
  });

  it('у облачного перевода появился исход чтения рядом с решением', () => {
    expect(CONSENT).toContain('export async function cloudTranslateAllowedRead(): Promise<boolean | null> {');
    const fn = codeOnly(slice(CONSENT, 'export async function cloudTranslateAllowedRead(', '\n}\n'));
    expect(fn).toContain('privacyPrefTryBoolFor(pid, CLOUD_TRANSLATE_KEY)');
    // Короткое решение осталось осторожным: не прочитали — нельзя.
    const short = codeOnly(slice(CONSENT, 'export async function cloudTranslateAllowedFor(', '\n}\n'));
    expect(short).toContain('=== true');
  });

  it('у автоудаления появился исход чтения, а короткая форма стала обёрткой', () => {
    expect(DISAPPEAR).toContain('export async function getDefaultDisappearMsReadFor(');
    const short = codeOnly(
      slice(DISAPPEAR, 'export async function getDefaultDisappearMsFor(', '\n}\n')
    );
    expect(short).toContain('(await getDefaultDisappearMsReadFor(profileId))?.ms ?? null');
    expect(DISAPPEAR).toContain('export async function getDefaultDisappearMsRead(): Promise<{ ms: number | null } | null> {');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: короткие формы по-прежнему гасят отказ', () => {
  it('kvGet сводит отказ базы к null', () => {
    const fn = slice(LOCAL, 'export async function kvGet(key: string)', '\n}\n');
    expect(fn).toContain('(await kvTryGet(key))?.value ?? null');
  });

  it('scopedKvGetFor сводит отказ базы к null', () => {
    const fn = slice(SCOPED, 'export async function scopedKvGetFor(', '\n}\n');
    expect(fn).toContain('?.value ?? null');
  });

  it('ownFieldGetFor сводит отказ базы к null', () => {
    const fn = slice(OWN, 'export async function ownFieldGetFor(', '\n}\n');
    expect(fn).toContain('?.text ?? null');
  });

  it('провал чтения автоудаления по-прежнему не кладётся в кэш', () => {
    // Опора не на имя функции: до правки разбор жил в getDefaultDisappearMsFor,
    // после — в getDefaultDisappearMsReadFor. Проверяется сам порядок: выход по
    // отказу стоит РАНЬШЕ записи в кэш, и так на обеих версиях кода.
    const nullIdx = DISAPPEAR.indexOf('if (got === null) return null;');
    const cacheIdx = DISAPPEAR.indexOf('cache.set(profileId,');
    expect(nullIdx).toBeGreaterThanOrEqual(0);
    expect(cacheIdx).toBeGreaterThan(nullIdx);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: экран настроек на месте', () => {
  it('надпись про непрочитанные настройки осталась слово в слово', () => {
    expect(SCREEN).toContain(
      "showError('Настройки не прочитались. То, что на экране, может не совпадать с сохранённым.')"
    );
    expect(SCREEN).toContain("log.error('settings_read_failed'");
  });

  it('разбор прочитанных значений не трогали', () => {
    expect(EFFECT).toContain("setNotifyDm(nDm !== 'false')");
    expect(EFFECT).toContain("setDndEnabled(dndEn === 'true')");
    expect(EFFECT).toContain("setDisableReadReceipts(disableRr === 'true')");
    expect(EFFECT).toContain('setDndStart(parseHourOfDay(dndS, 22))');
  });

  it('чтение по-прежнему одной пачкой и по-прежнему из двадцати пяти записей', () => {
    const batch = slice(SCREEN, 'void Promise.all([', '\n    ]).then(');
    const entries = batch
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith(','));
    expect(entries).toHaveLength(25);
  });
});
