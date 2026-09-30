/**
 * Сорванное чтение ленты сторис перестало выдаваться за «историй нет»
 * (v4.32.1075).
 *
 * ДЕФЕКТ. `reload()` в StoriesRow не имел ни одного `catch`, а звался тремя
 * `void reload()` и одним `await` после публикации. Внутри три похода в базу
 * — `deleteExpiredStories()`, `listActiveStories(pid)`, `listContacts()`, — и
 * первые два бросают на отказе базы или ключа шифрования. Бросок уходил в
 * необработанный промис: `groups` оставался `[]`, а ветка пустого состояния
 * рисует ровно один кружок «Добавить» — то есть «у ваших контактов историй
 * нет».
 *
 * ЦЕНА. Сторис живёт сутки и исчезает сама: пропущенную не открыть позже, в
 * переписке её нет, уведомления о ней нет. Отказ базы чаще всего случается в
 * первую секунду после запуска — ровно тогда, когда ряд и отрисовывается.
 *
 * ПРАВКА. Один `try` на всё чтение и третий ответ ряда: кружок
 * «Не открылись», по нажатию — повтор и объяснение словами. Прежде
 * прочитанное при позднейшем отказе не стирается, и текст тогда говорит
 * другое — «показано прежнее».
 *
 * ГРАНИЦЫ. Сторожи `aliveRef`, подписка на обновления и собственные ошибки
 * публикации не тронуты.
 */
import fs from 'fs';
import path from 'path';

import {
  STORIES_ROW_FAILED_LABEL,
  storiesRowFailedA11yLabel,
  storiesRowFailedHint,
} from '../storiesRowUnread';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const ROW = codeOnly(read('ui', 'components', 'StoriesRow.tsx'));
const LOCAL = codeOnly(read('core', 'storage', 'local.ts'));

describe('отказ чтения назван словами', () => {
  test('подпись под кружком короткая и не обещает пустоты', () => {
    expect(STORIES_ROW_FAILED_LABEL).toBe('Не открылись');
  });

  test('пустой ряд: сказано, что это не «историй нет», и почему стоит повторить', () => {
    const hint = storiesRowFailedHint(false);
    expect(hint).toContain('это не «историй нет»');
    expect(hint).toContain('сутки');
    expect(storiesRowFailedA11yLabel(false)).toContain('Нажмите, чтобы повторить');
  });

  test('непустой ряд: сказано другое — показанное устарело', () => {
    const hint = storiesRowFailedHint(true);
    expect(hint).toContain('показано то, что удалось прочитать раньше');
    expect(hint).not.toContain('это не «историй нет»');
    expect(storiesRowFailedA11yLabel(true)).toContain('не обновился');
  });

  test('ГРАНИЦА: два случая и правда разные тексты, а не один на оба', () => {
    expect(storiesRowFailedHint(true)).not.toBe(storiesRowFailedHint(false));
    expect(storiesRowFailedA11yLabel(true)).not.toBe(storiesRowFailedA11yLabel(false));
  });
});

describe('форма правки в ряду', () => {
  test('чтение обёрнуто, и отказ доходит до состояния, а не до журнала', () => {
    const at = ROW.indexOf('const reload = useCallback(async () => {');
    expect(at).toBeGreaterThan(0);
    const body = ROW.slice(at, ROW.indexOf('\n  }, [pid, myPubB64]);', at));
    expect(body).toContain('try {');
    expect(body).toContain('} catch (e) {');
    expect(body).toContain("log.warn('ui_stories_row_reload_failed', { err: rawErrorText(e) });");
    expect(body).toContain('if (aliveRef.current) setLoadFailed(true);');
    // Удача снимает пометку — иначе кружок остался бы навсегда.
    expect(body).toContain('setLoadFailed(false);');
    // И прежде прочитанное при отказе не стирается.
    expect(body).not.toContain('setGroups([])');
  });

  test('кружок отказа один на обе ветки отрисовки', () => {
    expect(ROW).toContain('const failureBubble = loadFailed ? (');
    expect(ROW).toContain('testID="stories_row_failed"');
    expect(ROW).toContain('<Text style={[sb.name, { color: c.textSecondary }]}>{STORIES_ROW_FAILED_LABEL}</Text>');
    // Ровно два места вставки: пустая ветка и обычная.
    expect([...ROW.matchAll(/\{failureBubble\}/g)]).toHaveLength(2);
  });

  test('нажатие и объясняет, и повторяет чтение', () => {
    expect(ROW).toContain('showError(storiesRowFailedHint(groups.length > 0));');
    expect(ROW).toContain('void reload();');
    expect(ROW).toContain('accessibilityLabel={storiesRowFailedA11yLabel(groups.length > 0)}');
  });

  test('ПРОВЕРКА НЕ ПУСТАЯ: сторожи и подписка ряда целы', () => {
    // v4.32.193: три сторожа против записи в размонтированный ряд.
    expect([...ROW.matchAll(/if \(!aliveRef\.current\) return;/g)]).toHaveLength(3);
    expect(ROW).toContain('const unsub = subscribeStoryUpdates(() => void reload());');
    expect(ROW).toContain('return () => { aliveRef.current = false; };');
  });

  test('ГРАНИЦА: публикация по-прежнему говорит о своих ошибках сама', () => {
    expect(ROW).toContain("showError(userErrorText(e, 'Не удалось опубликовать историю'));");
    expect(ROW).toContain('publishingRef.current = false;');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  test('чтение сторис и правда может броситься', () => {
    const at = LOCAL.indexOf('export async function listActiveStories(');
    expect(at).toBeGreaterThan(0);
    const body = LOCAL.slice(at, LOCAL.indexOf('\n}', at));
    // Оба похода бросают: своего catch у них нет.
    expect(body).toContain('const d = await db();');
    expect(body).toContain('const dek = await getOrCreateDataEncryptionKey();');
    expect(body).not.toContain('catch');
  });

  test('пустая ветка ряда и правда утверждает «историй нет»', () => {
    expect(ROW).toContain('if (groups.length === 0 && !hasMyStory) {');
    expect(ROW).toContain('testID="stories_row_wrap_empty"');
    // Единственный кружок в ней — «Добавить»: ни слова о том, что чтение
    // могло не состояться. (Что кружок отказа туда встал, проверено выше —
    // здесь речь о поводе, и он должен быть виден и на прежнем коде.)
    const at = ROW.indexOf('if (groups.length === 0 && !hasMyStory) {');
    const branch = ROW.slice(at, ROW.indexOf('\n  }\n', at));
    expect(branch).toContain('Добавить');
    expect(branch).not.toContain('StoryBubble');
  });
});
