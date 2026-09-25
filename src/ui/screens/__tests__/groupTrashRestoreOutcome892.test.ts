/**
 * Восстановление из групповой корзины отвечает за свой исход (v4.32.892).
 *
 * Дефект: `handleGrpRestoreDeleted` писал сообщение через `insertGroupMessage`
 * и выбрасывал ответ. Эта функция при отказе базы НЕ бросает — она отдаёт
 * `false` (`insertGroupMessageChecked` ловит исключение и возвращает
 * `'failed'`), поэтому `catch` вокруг обработчика сюда не приходил. Дальше шли
 * безусловно: вычёркивание записи из корзины, удаление её со списка,
 * перечитывание ленты и зелёное «Сообщение восстановлено».
 *
 * Цена: корзина — последняя копия текста. Это единственное место в приложении,
 * где промах записи уничтожает сообщение насовсем. В личных чатах симметричный
 * путь безопасен: там восстановление лишь кладёт текст обратно в поле ввода, в
 * базу ничего не пишется.
 *
 * Правка: ответ проверяется, и при отказе обработчик выходит до чистки корзины,
 * назвав отказ вслух. `id` строки выдан `uuidv4` прямо перед записью, так что
 * третий исход `'duplicate'` здесь невозможен и различать его незачем.
 *
 * Проверяется форма исходника: экран групп в тестах не монтируется (его
 * дерево тянет карты, камеру и звук), а спорное здесь — порядок шагов внутри
 * одного обработчика. Положительные контроли ниже держат вырезку.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..', '..');
/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');

const groups = (): string => bare('ui/screens/GroupsScreen.tsx');

/** Тело `handleGrpRestoreDeleted` — от объявления до следующего `useCallback`. */
function restoreHandler(): string {
  const s = groups();
  const at = s.indexOf('const handleGrpRestoreDeleted = useCallback(');
  expect(at).toBeGreaterThan(0);
  const end = s.indexOf('const loadMore = useCallback(', at);
  expect(end).toBeGreaterThan(at);
  return s.slice(at, end);
}

describe('отказ записи не выдаётся за восстановление', () => {
  it('ответ `insertGroupMessage` больше не выбрасывается', () => {
    const h = restoreHandler();
    expect(h).not.toContain('await insertGroupMessage(row);');
    expect(h).toContain('if (!(await insertGroupMessage(row))) {');
  });

  it('при отказе человеку сказано, и сказано, где текст остался', () => {
    const h = restoreHandler();
    const guard = h.indexOf('if (!(await insertGroupMessage(row))) {');
    expect(guard).toBeGreaterThan(0);
    const tail = h.slice(guard, guard + 320);
    const said = tail.indexOf(
      "showError('Не удалось восстановить сообщение. Оно осталось в «Недавно удалённых»');"
    );
    expect(said).toBeGreaterThan(0);
    expect(tail.indexOf('return;', said)).toBeGreaterThan(said);
  });

  it('корзина чистится только после проверки — запись переживает отказ', () => {
    const h = restoreHandler();
    const guard = h.indexOf('if (!(await insertGroupMessage(row))) {');
    expect(guard).toBeGreaterThan(0);
    // Оба шага, убирающие запись: и в хранилище, и со списка на экране.
    expect(h.indexOf('await kvUpdateSecretScoped(pid, recentlyDeletedGroupKey(group.id), (raw) => {')).toBeGreaterThan(guard);
    expect(h.indexOf('setGrpRecentlyDeletedList((prev) => prev.filter((x) => x.id !== entry.id));')).toBeGreaterThan(guard);
  });

  it('«Сообщение восстановлено» стоит ниже проверки, а не выше', () => {
    const h = restoreHandler();
    const guard = h.indexOf('if (!(await insertGroupMessage(row))) {');
    expect(guard).toBeGreaterThan(0);
    expect(h.indexOf("showSuccess('Сообщение восстановлено');")).toBeGreaterThan(guard);
    expect(h.indexOf('await loadMessages();')).toBeGreaterThan(guard);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: восстановление осталось восстановлением', () => {
  it('строка собирается с новым id и прежними полями', () => {
    const h = restoreHandler();
    expect(h).toContain("const { v4: uuidv4r } = await import('uuid');");
    expect(h).toContain('id: uuidv4r(),');
    expect(h).toContain('senderName: entry.senderName,');
    expect(h).toContain('text: entry.text,');
    expect(h).toContain('ownerProfileId: pid,');
  });

  it('удача по-прежнему чистит корзину, перечитывает ленту и хвалится', () => {
    const h = restoreHandler();
    expect(h).toContain('await kvUpdateSecretScoped(pid, recentlyDeletedGroupKey(group.id), (raw) => {');
    expect(h).toContain('return JSON.stringify(list.filter((x) => x.id !== entry.id));');
    expect(h).toContain('await loadMessages();');
    expect(h).toContain("showSuccess('Сообщение восстановлено');");
  });

  it('прежний перехват исключений на месте — он ловит другое', () => {
    const h = restoreHandler();
    expect(h).toContain("showError(userErrorText(e, 'Не удалось восстановить сообщение'));");
  });

  it('правка v4.32.552 цела: корзина переписывается слиянием, а не пустым списком', () => {
    const h = restoreHandler();
    expect(h).toContain('kvUpdateSecretScoped');
    expect(h).not.toContain('kvSetSecretScoped(pid, recentlyDeletedGroupKey(');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('`insertGroupMessage` при отказе базы отвечает `false`, а не бросает', () => {
    const s = bare('core/storage/local.ts');
    expect(s).toContain('export async function insertGroupMessage(msg: GroupMessageRow): Promise<boolean> {');
    expect(s).toContain("return (await insertGroupMessageChecked(msg)) === 'inserted';");
    const at = s.indexOf('export async function insertGroupMessageChecked(');
    const body = s.slice(at, at + 900);
    expect(body).toContain('} catch (e) {');
    expect(body).toContain("return 'failed';");
    // Исключение наружу не уходит: последнее, что делает catch, — возврат.
    expect(body).not.toContain('throw e;');
  });

  it('корзина группы и правда последняя копия: удаление стирает строку', () => {
    const s = bare('ui/screens/GroupsScreen.tsx');
    expect(s).toContain('recentlyDeletedGroupKey');
    expect(s).toContain('deleteGroupMessage');
  });

  it('в личных чатах восстановление действительно безопаснее — в базу не пишет', () => {
    const s = bare('ui/screens/ChatScreen.tsx');
    expect(s).toContain('Текст восстановлен в поле ввода');
  });
});
