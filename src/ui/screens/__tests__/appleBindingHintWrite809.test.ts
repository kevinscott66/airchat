/**
 * Подсказка о привязке слов к Apple ID перестала врать после отказа базы
 * (v4.32.809).
 *
 * Дефект. Три места писали её через `scopedKvSet(...)`. `scopedKvSet` отдаёт
 * `void`: внутри у него `scopedKvSetCheckedFor`, который ответ базы знает, а
 * обёртка этот ответ роняет. Сверх того, в `markAppleBindingStaleAfterPassword
 * Change` обе отметки в интерфейсе стояли ПОСЛЕ записи внутри одного `try`, а
 * подпись у `catch` гласила «привязка и так помечена в интерфейсе» — то есть
 * описывала ровно то, чего при броске как раз не случалось.
 *
 * Цена. Подсказка — единственное, из чего экран строит строку «Слова привязаны
 * к Apple ID». Конверт со словами лежит на сервере, зашифрованный паролем на
 * момент привязки; сменили пароль — он новым уже не откроется, и третье
 * состояние `stale` заводили в v4.32.615 именно затем, чтобы человек узнал об
 * этом сегодня, а не в единственный день, когда слов на руках уже нет. Если
 * запись `stale` не легла, предупреждение показывалось один раз и умирало
 * вместе с экраном: после перезапуска строка снова обещала запасной путь,
 * которого нет. Симметрично с двух других сторон: незаписанный `bound` прячет
 * кнопку «отвязать» при живой копии на сервере, незаписанный `none` обещает
 * копию, которой больше нет.
 *
 * Правка. Все три записи идут через `storeAppleBindingHint` на
 * `scopedKvSetChecked`, и каждое из трёх мест говорит человеку, легла ли
 * пометка. Отметки в интерфейсе выставляются до записи и от неё не зависят.
 * Заодно закрыт четвёртый `scopedKvSet` экрана — язык перевода: для настроек в
 * namespace профиля появился `applyScopedPref`, брат `applyKvPref` из
 * v4.32.808, и на экране не осталось ни одной записи мимо ответа базы.
 */
import fs from 'fs';
import path from 'path';

import {
  APPLE_BINDING_STORED,
  hintAfterPasswordChange,
  parseAppleBindingHint,
} from '../../../core/security/appleBindingHint';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SETTINGS = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
/** v4.32.868: правило переехало в ядро — часть закрепов смотрит туда. */
const STALE = codeOnly(read('core', 'security', 'appleBindingStale.ts'));
const SCOPED = codeOnly(read('core', 'storage', 'profileScopedKv.ts'));

describe('подсказка о привязке пишется проверяемо', () => {
  it('на экране не осталось ни одной записи через scopedKvSet', () => {
    expect(SETTINGS).not.toContain('scopedKvSet(');
    expect(SETTINGS).not.toContain('void scopedKvSet');
    // И имени в импортах: незанятая дверь однажды снова откроется.
    expect(SETTINGS).toContain(
      "import { scopedKvGet, scopedKvSetChecked } from '../../core/storage/profileScopedKv';",
    );
  });

  it('запись подсказки одна на три места и возвращает ответ базы', () => {
    expect(SETTINGS).toContain(
      'const storeAppleBindingHint = useCallback(async (hint: AppleBindingHint): Promise<boolean> => {',
    );
    expect(SETTINGS).toContain(
      'return await scopedKvSetChecked(APPLE_BINDING_HINT_KEY, APPLE_BINDING_STORED[hint]);',
    );
    // Бросок гасится осознанно: конверт на сервере к этому моменту уже создан
    // или удалён, и ронять сделанную работу на подсказке нельзя.
    expect(SETTINGS).toContain("log.warn('apple_binding_hint_write_failed', { err: rawErrorText(e) });");
  });

  it('пометка в интерфейсе не зависит от того, легла ли запись', () => {
    // v4.32.868. Прежде это проверялось буквально по порядку строк: обе
    // отметки стояли ДО `await storeAppleBindingHint(next)`. Теперь чтение,
    // решение и запись ушли в ядро, а оно не бросает вовсе — отвечает словом.
    // v4.32.869: копий две, и обработчик метит обе. Смысл закрепа тот же: ни
    // один исход записи не уносит с собой пометку в интерфейсе, и выход мимо
    // неё ровно один — «метить нечего».
    const at = SETTINGS.indexOf('const markCopiesStaleAfterPasswordChange');
    expect(at).toBeGreaterThan(0);
    // Ровно тело обработчика, до его закрывающей скобки: окном «столько-то
    // символов» проверка досрочных выходов цепляла соседа.
    const end = SETTINGS.indexOf('\n  };', at);
    expect(end).toBeGreaterThan(at);
    const body = SETTINGS.slice(at, end);
    expect(body).toContain('const report = await markPasswordBoundCopiesStale();');
    expect(body).toContain("if (apple !== 'not_bound') { setAppleBound(false); setAppleBindStale(true); }");
    expect(body).toContain("if (cloud !== 'not_bound') setCloudCopy('stale');");
    // Досрочных выходов нет вовсе: раньше их было два, и каждый уносил с собой
    // всё, что стояло ниже.
    expect([...body.matchAll(/\breturn;/g)]).toHaveLength(0);
    // А ядро на любой отказ отвечает словом: бросить оно не может.
    expect(STALE).toContain("return 'unknown';");
    expect(STALE).toContain("return ok ? 'marked' : 'unwritten';");
    expect(STALE.split('catch (e) {').length - 1).toBe(2);
  });

  it('несостоявшаяся пометка «устарела» названа своим именем', () => {
    // Мягкого текста тут мало: человек только что сменил пароль, слова ещё на
    // устройстве, и привязать заново он может ровно сейчас.
    // v4.32.868: оба текста переехали в ядро — их показывают уже два экрана.
    expect(STALE).toContain(
      "  marked: 'Привязка к Apple ID больше не откроется новым паролем — привяжите слова заново.',",
    );
    expect(STALE).toContain(
      "    'Привязка к Apple ID больше не откроется новым паролем, а пометить её не удалось: после перезапуска настройки снова покажут «привязаны». Привяжите слова заново сейчас.',",
    );
    // v4.32.869: строку собирает общий разбор — копий, запертых паролем, две.
    expect(SETTINGS).toContain('const text = passwordChangeAftermathText({ apple, cloud });');
    expect(SETTINGS).toContain('if (text) showError(text);');
  });

  it('нечитаемая подсказка решается по тому, что показывает экран', () => {
    // Иначе бросок на чтении означал бы «ничего не делать» — и молчание ровно
    // там, где привязка на экране стоит как живая.
    // v4.32.868: ядро на нечитаемой подсказке отвечает `unknown` и ничего не
    // решает за вызывающего — свидетеля ищет тот, у кого он есть.
    // v4.32.869: свидетелей на этом экране теперь два, по одному на копию.
    expect(SETTINGS).toContain("const apple = report.apple !== 'unknown'");
    expect(SETTINGS).toContain("(await storeAppleBindingHint('stale')) ? 'marked' : 'unwritten';");
    expect(SETTINGS).toContain("const cloud = report.cloud !== 'unknown'");
    expect(SETTINGS).toContain("(await storeCloudVaultCopy('stale')) ? 'marked' : 'unwritten';");
  });

  it('привязка и отвязка тоже отвечают за пометку', () => {
    expect(SETTINGS).toContain("showSuccess(await storeAppleBindingHint('bound')");
    expect(SETTINGS).toContain(
      ": 'Слова привязаны к Apple ID, но пометка не сохранилась: после перезапуска настройки снова предложат привязать. Копия на сервере при этом есть.');",
    );
    expect(SETTINGS).toContain("if (await storeAppleBindingHint('none')) {");
    expect(SETTINGS).toContain(
      "showError('Apple ID отвязан, но пометка не сохранилась: после перезапуска настройки снова покажут привязку, хотя копии на сервере уже нет.');",
    );
  });

  it('язык перевода закрыт тем же правилом, с откатом на прежний', () => {
    expect(SETTINGS).toContain('const applyScopedPref = useCallback(');
    expect(SETTINGS).toContain('void applyPref(() => scopedKvSetChecked(key, value), revert);');
    expect(SETTINGS).toContain(
      'const prev = translateLang; setTranslateLang(code); applyScopedPref(TRANSLATION_TARGET_LANG_KEY, code, () => setTranslateLang(prev));',
    );
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: разбор подсказки не менялся', () => {
  it('три состояния на месте и незнакомое читается как «нет»', () => {
    expect(parseAppleBindingHint(APPLE_BINDING_STORED.bound)).toBe('bound');
    expect(parseAppleBindingHint(APPLE_BINDING_STORED.stale)).toBe('stale');
    expect(parseAppleBindingHint(APPLE_BINDING_STORED.none)).toBe('none');
    expect(parseAppleBindingHint(null)).toBe('none');
    expect(parseAppleBindingHint('что-то ещё')).toBe('none');
  });

  it('смена пароля трогает только живую привязку', () => {
    expect(hintAfterPasswordChange('bound')).toBe('stale');
    expect(hintAfterPasswordChange('stale')).toBeNull();
    expect(hintAfterPasswordChange('none')).toBeNull();
  });

  it('строка настроек по-прежнему строится из трёх состояний', () => {
    expect(SETTINGS).toContain("? 'Слова привязаны к Apple ID'");
    expect(SETTINGS).toContain("? 'Привязка к Apple ID устарела'");
    expect(SETTINGS).toContain(": 'Привязать слова к Apple ID'");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('scopedKvSet действительно роняет ответ, который знает', () => {
    expect(SCOPED).toContain(
      'export async function scopedKvSetFor(pid: number, key: string, value: string): Promise<void> {\n  await scopedKvSetCheckedFor(pid, key, value);\n}',
    );
    expect(SCOPED).toContain(
      'export async function scopedKvSetChecked(key: string, value: string): Promise<boolean> {',
    );
    expect(SCOPED).toContain(
      'export async function scopedKvSetCheckedFor(pid: number, key: string, value: string): Promise<boolean> {',
    );
  });

  it('подсказка — единственный источник строки, и сервер её не подтверждает', () => {
    // Спросить сервер «есть ли конверт» экран не может: listSeedBindingProviders
    // отвечает только про то, какие способы вообще настроены.
    expect(SETTINGS).toContain('providers = await listSeedBindingProviders();');
    expect(SETTINGS).toContain("setAppleBound(hint === 'bound');");
    expect(SETTINGS).toContain("setAppleBindStale(hint === 'stale');");
  });
});
