/**
 * Непрочитанный список запретов выдавался за пустой (v4.32.1066).
 *
 * ДЕФЕКТ. Экран контактов поднимал блок-лист так:
 * `try { setBlockedSet(new Set(await rateLimiter.getBlockedPubKeys())); }
 * catch { /* ignore *\/ }`. Но `getBlockedPubKeys` не бросает: он ждёт
 * `whenReady` (тот даёт чтению второй заход) и отдаёт то, что в памяти. Если
 * и второй заход сорвался — в памяти пусто, и сюда приходил пустой массив,
 * неотличимый от «никого не блокировал». Отличить их можно:
 * `rateLimiter.blockedListReadable()` заведён ровно для этого, и переписка
 * (v4.32.1048), карточка собеседника (v4.32.1051), лента, отправка и приём
 * спрашивают его давно. Экран контактов был последним местом, где блокировка
 * живёт, и единственным, который не спрашивал.
 *
 * ЦЕНА. У заблокированного пропадали все три отметки: значок `ban`,
 * зачёркнутое имя и подпись «🚫 Заблокирован», — строка выглядела обычной.
 * Меню строки и диалог «Контакт уже добавлен» предлагали «Заблокировать»
 * вместо «Разблокировать», то есть снять запрет отсюда было нечем: пункта
 * просто не было. Сорванное чтение — это занятая при открытии база, ровно тот
 * момент, когда экран и поднимается.
 *
 * ПРАВКА. Спросить `blockedListReadable()` рядом с чтением. Непрочитанный
 * ответ прежде показанного не затирает (удачное чтение было правдой), над
 * списком появляется янтарная строка, а пункт меню называется теми же
 * словами, что в переписке и в карточке. Кнопку не гасим: запрет мог и не
 * стоять, а отнятое действие из-за занятой базы стоит дороже подписи; что
 * запись не ляжет, скажет сам ограничитель (BLOCK_NOT_SAVED_ON/OFF).
 *
 * ГРАНИЦЫ. Прочитанный пустой список — обычное «никого не блокировал», и
 * тогда над списком молчание. Отказ не вечный: следующее «потяните вниз»
 * читает заново, поэтому так и сказано.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  blockActionLabel,
  BLOCKED_LIST_UNKNOWN_NOTE,
  BLOCKED_UNKNOWN_HEAD,
} from '../../utils/blockActionLabel';

/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => codeOnly(readFileSync(join(SRC, ...p), 'utf8'));

const SCREEN = (): string => read('ui', 'screens', 'ContactsScreen.tsx');
const CHAT = (): string => read('ui', 'screens', 'ChatScreen.tsx');
const HUB = (): string => read('ui', 'components', 'profileHubModel.ts');
const LIMITER = (): string => read('core', 'security', 'rateLimiter.ts');

describe('как назвать пункт меню', () => {
  it('заблокирован — предлагаем снять запрет', () => {
    expect(blockActionLabel(true, false)).toBe('Разблокировать');
  });

  it('список прочитан, запрета нет — обычная подпись', () => {
    expect(blockActionLabel(false, false)).toBe('Заблокировать');
  });

  it('список не прочитан — сказано об этом в самой подписи', () => {
    expect(blockActionLabel(false, true)).toBe('Заблокировать (список запретов не прочитан)');
  });

  it('ГРАНИЦА: непрочитанный список не отменяет самого действия', () => {
    // Подпись предупреждает, но пункт остаётся тем же: запрет мог и не
    // стоять, а отнятое действие из-за занятой базы — вред больше.
    expect(blockActionLabel(false, true).startsWith('Заблокировать')).toBe(true);
  });

  it('ГРАНИЦА: известный запрет важнее незнания про список', () => {
    // Множество помнит прошлое удачное чтение; предложить снять запрет по
    // нему честнее, чем промолчать. Не ляжет запись — скажет ограничитель.
    expect(blockActionLabel(true, true)).toBe('Разблокировать');
  });

  it('строка над списком называет и беду, и способ повторить', () => {
    expect(BLOCKED_LIST_UNKNOWN_NOTE).toContain('не прочитан');
    expect(BLOCKED_LIST_UNKNOWN_NOTE).toContain('могут быть не показаны');
    expect(BLOCKED_LIST_UNKNOWN_NOTE).toContain('Потяните список вниз');
    expect(BLOCKED_UNKNOWN_HEAD).toContain('Запрет проверить не удалось');
  });
});

describe('три места говорят об одном одними словами', () => {
  it('переписка и карточка собеседника держат ту же подпись', () => {
    const said = blockActionLabel(false, true);
    expect(CHAT()).toContain(said);
    expect(HUB()).toContain(said);
  });
});

describe('форма исходника экрана контактов', () => {
  it('чтение спрашивает признак, а не выводит его из пустоты', () => {
    const s = SCREEN();
    expect(s).toContain('await rateLimiter.whenReady();');
    expect(s).toContain('const readable = rateLimiter.blockedListReadable();');
    expect(s).toContain('setBlockUnknown(!readable);');
    expect(s).toContain('if (readable) setBlockedSet(new Set(await rateLimiter.getBlockedPubKeys()));');
  });

  it('прежде показанное непрочитанным ответом не затирается', () => {
    const s = SCREEN();
    // Присвоение множества осталось ровно одно — под проверкой `readable`.
    expect(s.match(/setBlockedSet\(/g)?.length).toBe(1);
    const at = s.indexOf('const readable = rateLimiter.blockedListReadable();');
    expect(at).toBeGreaterThan(0);
    expect(s.indexOf('setBlockedSet(')).toBeGreaterThan(at);
  });

  it('сорвавшееся чтение больше не проглатывается молча', () => {
    const s = SCREEN();
    const at = s.indexOf('const readable = rateLimiter.blockedListReadable();');
    const tail = s.slice(at, at + 400);
    expect(tail).toContain('} catch {');
    expect(tail).toContain('setBlockUnknown(true);');
    expect(tail).not.toContain('/* ignore */');
  });

  it('обе развилки меню берут подпись из общего правила', () => {
    const s = SCREEN();
    expect(s).toContain('text: blockActionLabel(isBlocked, blockUnknown),');
    expect(s).toContain('text: blockActionLabel(alreadyBlocked, blockUnknown),');
    // Прежние безусловные подписи ушли из файла целиком.
    expect(s).not.toContain("text: isBlocked ? 'Разблокировать' : 'Заблокировать',");
    expect(s).not.toContain("text: alreadyBlocked ? 'Разблокировать' : 'Заблокировать',");
  });

  it('шапка меню строки и строка над списком говорят о том же', () => {
    const s = SCREEN();
    expect(s).toContain("(isBlocked ? '\\n\\n🚫 Заблокирован' : blockUnknown ? BLOCKED_UNKNOWN_HEAD : '')");
    expect(s).toContain('testID="contacts_block_unknown_note"');
    expect(s).toContain('{BLOCKED_LIST_UNKNOWN_NOTE}');
    // Янтарь — второй сигнал, как у прочих непрочитанных настроек.
    const at = s.indexOf('testID="contacts_block_unknown_note"');
    expect(s.slice(at - 200, at)).toContain('colors.warning');
  });

  it('пометка держится состоянием экрана, а не считается заново в рендере', () => {
    const s = SCREEN();
    expect(s).toContain('const [blockUnknown, setBlockUnknown] = useState(false);');
    // Обе замыкающие её callback-функции пересобираются при смене пометки —
    // иначе меню осталось бы со старой подписью.
    expect(s).toContain('}, [onOpenChatWithPeer, blockedSet, blockUnknown, load]);');
    // v4.32.1089: закрепка держит смысл, а не буквальный список. Из
    // зависимостей submitAdd ушёл isDuplicate — проверка двойника перестала
    // верить состоянию экрана и читает книгу заново. Важно здесь ровно одно:
    // пометка входит в зависимости и окно добавления пересобирается при её
    // смене.
    const addAt = s.indexOf('const submitAdd = useCallback(async () => {');
    expect(addAt).toBeGreaterThan(-1);
    const depsAt = s.indexOf('\n  }, [', addAt);
    expect(depsAt).toBeGreaterThan(addAt);
    const addDeps = s.slice(depsAt, s.indexOf(']);', depsAt) + 3);
    expect(addDeps).toContain('blockUnknown');
    expect(addDeps).toContain('blockedSet');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('getBlockedPubKeys по-прежнему отдаёт голый массив и не бросает', () => {
    const l = LIMITER();
    const at = l.indexOf('async getBlockedPubKeys(): Promise<string[]> {');
    expect(at).toBeGreaterThan(0);
    const body = l.slice(at, at + 140);
    expect(body).toContain('await this.whenReady();');
    expect(body).toContain('return [...this.blocked];');
    // Ни слова об исходе чтения — отличить пустоту от незнания тут нечем.
    expect(body).not.toContain('loadFailed');
  });

  it('blockedListReadable — то самое место, где разница объявлена', () => {
    const l = LIMITER();
    expect(l).toContain('blockedListReadable(): boolean {');
    const at = l.indexOf('blockedListReadable(): boolean {');
    expect(l.slice(at, at + 90)).toContain('return !this.loadFailed;');
  });

  it('запись поверх непрочитанного списка по-прежнему отказывает', () => {
    // Значит, «Заблокировать» при непрочитанном списке не молчит: отказ
    // доходит до человека строками BLOCK_NOT_SAVED_ON/OFF, и гасить пункт
    // ради этого незачем.
    const l = LIMITER();
    const at = l.indexOf('private async persistBlocked(pid: number): Promise<boolean> {');
    expect(at).toBeGreaterThan(0);
    expect(l.slice(at, at + 200)).toContain('if (this.loadFailed) {');
    const s = SCREEN();
    expect(s).toContain('showError(BLOCK_NOT_SAVED_OFF)');
    expect(s).toContain('showError(BLOCK_NOT_SAVED_ON)');
  });

  it('строка контакта всё так же рисуется по множеству', () => {
    const s = SCREEN();
    expect(s).toContain('isBlocked={blockedSet.has(item.peerPublicKey)}');
    expect(s).toContain("'🚫 Заблокирован'");
    expect(s).toContain("textDecorationLine: 'line-through' as const");
  });
});

describe('ЗАКРЕПКА', () => {
  it('правило лежит отдельно от экрана и без импортов', () => {
    const rule = readFileSync(join(SRC, 'ui', 'utils', 'blockActionLabel.ts'), 'utf8');
    expect(codeOnly(rule)).not.toContain('import ');
  });
});
