/**
 * Настройки чата и группы отвечают за свой исход (v4.32.897).
 *
 * Дефект: автоперевод и размер шрифта писались через `scopedKvSet`. Та гасит
 * ответ базы и отдаёт `void` — то есть отказ записи здесь не терялся даже,
 * его неоткуда было взять. Положение на экране менялось, на диске оставалось
 * прежнее, и при следующем открытии разговора возвращалось оно.
 *
 * Цена у размера шрифта своя, у автоперевода — чужая. Выключенный автоперевод
 * означает, что текст переписки больше не уходит в переводчик. «Выключилось,
 * но не сохранилось» вернёт отправку после перезапуска, не сказав ни слова, —
 * при том что выключают его как раз затем, чтобы разговор никуда не уезжал.
 *
 * Правка: те же четыре места пишут проверяемой формой, возвращают положение и
 * говорят словами — правило экрана настроек (v4.32.809), только заведено оно
 * там, где настройка живёт.
 *
 * Проверяется форма исходника: общего поведенческого стыка у двух экранов нет
 * (разные окна, разные пути), общее у них — выброшенный ответ записи.
 * Положительные контроли ниже держат каждую вырезку.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SCREENS = join(__dirname, '..');
/** Файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (rel: string): string =>
  readFileSync(join(SCREENS, rel), 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
const count = (s: string, needle: string): number => s.split(needle).length - 1;

const FAILED = "showError('Настройка не сохранилась. Попробуйте ещё раз.');";

describe('автоперевод не выключается только на экране', () => {
  it('личный чат: состояние меняется только после удавшейся записи', () => {
    const s = bare('ChatScreen.tsx');
    expect(s).not.toContain("await scopedKvSet(chatAutoTranslateKey(peerB64), newVal ? '1' : '0');");
    const guard = s.indexOf("if (!(await scopedKvSetChecked(chatAutoTranslateKey(peerB64), newVal ? '1' : '0'))) {");
    expect(guard).toBeGreaterThan(0);
    const tail = s.slice(guard, guard + 400);
    const said = tail.indexOf(FAILED);
    expect(said).toBeGreaterThan(0);
    expect(tail.indexOf('return;', said)).toBeGreaterThan(said);
    // И оба следствия включения стоят ПОСЛЕ проверки, а не до неё.
    expect(s.indexOf('setAutoTranslate(newVal);', guard)).toBeGreaterThan(guard);
    expect(s.indexOf('if (!newVal) setTranslationCache({});', guard)).toBeGreaterThan(guard);
  });

  it('группа: то же, и рычажок окна возвращается своей перерисовкой', () => {
    const s = bare('GroupsScreen.tsx');
    expect(s).not.toContain("void scopedKvSet(chatAutoTranslateKey(groupConvId(group.id)), newVal ? '1' : '0')");
    const at = s.indexOf(
      "void scopedKvSetChecked(chatAutoTranslateKey(groupConvId(group.id)), newVal ? '1' : '0').then((ok) => {",
    );
    expect(at).toBeGreaterThan(0);
    const tail = s.slice(at, at + 400);
    const said = tail.indexOf(FAILED);
    expect(tail.indexOf('if (!ok) {')).toBeGreaterThan(-1);
    expect(said).toBeGreaterThan(0);
    expect(tail.indexOf('setAutoTranslate(newVal);')).toBeGreaterThan(said);
  });
});

describe('размер шрифта возвращается к прежнему, если не записался', () => {
  it('личный чат: прежний размер запоминается до записи', () => {
    const s = bare('ChatScreen.tsx');
    expect(s).not.toContain("void scopedKvSet(chatFontSizeKey(peerB64)");
    const at = s.indexOf('const prev = chatFontSize;');
    expect(at).toBeGreaterThan(0);
    const tail = s.slice(at, at + 500);
    expect(tail.indexOf('setChatFontSize(sz);')).toBeGreaterThan(0);
    const wrote = tail.indexOf("void scopedKvSetChecked(chatFontSizeKey(peerB64), sz ? String(sz) : '').then((ok) => {");
    expect(wrote).toBeGreaterThan(0);
    expect(tail.indexOf('setChatFontSize(prev);', wrote)).toBeGreaterThan(wrote);
    expect(tail.indexOf(FAILED, wrote)).toBeGreaterThan(wrote);
  });

  it('группа: пять кнопок писали мимо ответа — теперь одна общая проверка', () => {
    const s = bare('GroupsScreen.tsx');
    expect(count(s, 'void scopedKvSet(chatFontSizeKey(groupConvId(group.id))')).toBe(0);
    const at = s.indexOf('const pickFontSize = (sz: number | null) => () => {');
    expect(at).toBeGreaterThan(0);
    const tail = s.slice(at, at + 600);
    expect(tail.indexOf('const prev = grpChatFontSize;')).toBeGreaterThan(0);
    const wrote = tail.indexOf(
      "void scopedKvSetChecked(chatFontSizeKey(groupConvId(group.id)), sz ? String(sz) : '').then((ok) => {",
    );
    expect(wrote).toBeGreaterThan(0);
    expect(tail.indexOf('setGrpChatFontSize(prev);', wrote)).toBeGreaterThan(wrote);
    expect(tail.indexOf(FAILED, wrote)).toBeGreaterThan(wrote);
    // Все пять кнопок зовут её, своей записи ни у одной не осталось.
    for (const label of ['Маленький (13)', 'Обычный (15)', 'Крупный (17)', 'Очень крупный (20)', 'По умолчанию']) {
      const row = s.slice(s.indexOf(`text: '${label}'`), s.indexOf(`text: '${label}'`) + 120);
      expect(row).toContain('onPress: pickFontSize(');
    }
  });
});

describe('проверяемая запись ввезена в оба экрана', () => {
  it('обе вырезки берут её из того же места, что и экран настроек', () => {
    for (const rel of ['ChatScreen.tsx', 'GroupsScreen.tsx']) {
      expect(bare(rel)).toContain("scopedKvSetChecked, scopedKvTryGet } from '../../core/storage/profileScopedKv';");
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('слова человеку не выдуманы: ровно так говорит экран настроек', () => {
    expect(bare('SettingsScreen.tsx')).toContain("showError('Настройка не сохранилась. Попробуйте ещё раз.');");
  });

  it('обоим экранам есть чем сказать: `showError` у них свой и давний', () => {
    expect(count(bare('ChatScreen.tsx'), 'showError(')).toBeGreaterThan(50);
    expect(count(bare('GroupsScreen.tsx'), 'showError(')).toBeGreaterThan(50);
  });

  it('чтение этих же настроек не тронуто', () => {
    expect(bare('ChatScreen.tsx')).toContain('const raw = await scopedKvGet(chatAutoTranslateKey(peerB64));');
    expect(bare('GroupsScreen.tsx')).toContain('void scopedKvGet(chatAutoTranslateKey(groupConvId(group.id))).then((raw) => {');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('`scopedKvSet` так и остаётся void поверх проверяемой записи', () => {
    const kv = readFileSync(join(SCREENS, '..', '..', 'core', 'storage', 'profileScopedKv.ts'), 'utf8');
    expect(kv).toContain('export async function scopedKvSet(key: string, value: string): Promise<void> {');
    expect(kv).toContain('export async function scopedKvSetChecked(key: string, value: string): Promise<boolean> {');
  });

  it('автоперевод действительно отправляет текст наружу', () => {
    // Иначе «не сохранилось» было бы косметикой, а не ценой.
    const s = bare('ChatScreen.tsx');
    expect(s).toContain('if (!newVal) setTranslationCache({});');
    expect(s).toContain('const raw = await scopedKvGet(chatAutoTranslateKey(peerB64));');
  });
});
