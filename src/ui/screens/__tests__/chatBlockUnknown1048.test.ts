/**
 * Непрочитанный список запретов выглядел как «этого я не блокировал» (v4.32.1048).
 *
 * ДЕФЕКТ. Экран переписки спрашивал `rateLimiter.isBlocked(peerB64)` и больше
 * ничего. У этого ответа нет «не знаю»: не подняв список с диска, он отвечает
 * «не заблокирован» кому угодно (`loadFailed`, v4.32.498). Отдельный экран
 * «Заблокированные» эту разницу называет с v4.32.635, отправка — с v4.32.1044,
 * а переписка — нет.
 *
 * ЦЕНА. Над человеком, которого я заблокировал, экран выглядел так, будто
 * запрета никогда не было: обычная кнопка меню вместо «ban», подпись поля
 * «Сообщение», в меню «Заблокировать». Причём в эту минуту запреты и правда не
 * действуют — список не прочитан, — то есть экран молчал ровно тогда, когда
 * сказать было о чём.
 *
 * ПРАВКА. Рядом с `isBlocked` спрашивается `blockedListReadable()`. Непрочитанный
 * список — третье состояние: своя подпись у поля ввода, свой значок в шапке,
 * своя приписка в меню. Поле остаётся рабочим намеренно: отправка сама откажет
 * и назовёт причину (v4.32.1044), а текст при отказе остаётся на месте — терять
 * его дважды незачем.
 *
 * ГРАНИЦЫ. Прочитанный список ведёт себя как прежде — обе прежние подписи и оба
 * прежних значка на месте. Удавшаяся запись запрета снимает пометку сама:
 * сохранение отказывает как раз тогда, когда список не прочитан.
 *
 * Поведение проверяется по форме исходников: поднять здесь настоящий экран
 * нечем (react-test-renderer в проекте нет) — тот же приём, что в
 * convReadOutcome650 и blockConfirm916.
 */
import fs from 'fs';
import path from 'path';

import { rateLimiter } from '../../../core/security/rateLimiter';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const CHAT = () => read('ui', 'screens', 'ChatScreen.tsx');
const LIST = () => read('ui', 'components', 'BlockedContactsList.tsx');

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const EFFECT = () =>
  slice(CHAT(), 'if (!peerB64) { setIsBlocked(false);', 'return () => { alive = false; };');

describe('состояние запрета спрашивается исходом чтения', () => {
  it('рядом с `isBlocked` спрашивается, прочитан ли список', () => {
    const body = EFFECT();
    expect(body).toContain('const readable = rateLimiter.blockedListReadable();');
    expect(body).toContain('setBlockUnknown(!readable);');
    expect(body).toContain('setIsBlocked(readable && rateLimiter.isBlocked(peerB64));');
  });

  it('непрочитанное состояние держится своим состоянием, а не выводится из false', () => {
    expect(CHAT()).toContain('const [blockUnknown, setBlockUnknown] = useState(false);');
  });

  it('уход с переписки пометку снимает, иначе она переедет на другого собеседника', () => {
    expect(EFFECT()).toContain('if (!peerB64) { setIsBlocked(false); setBlockUnknown(false); return; }');
  });
});

describe('что человек видит, когда не выяснили', () => {
  it('подпись поля ввода говорит про непроверенную блокировку', () => {
    const body = slice(CHAT(), 'placeholder={', 'placeholderTextColor');
    expect(body).toContain("? 'Контакт заблокирован'");
    expect(body).toContain(': blockUnknown');
    expect(body).toContain("? 'Блокировку проверить не удалось'");
  });

  it('значок в шапке отличается от обычного', () => {
    const body = slice(CHAT(), '<Ionicons\n                name={isBlocked ?', '/>');
    expect(body).toContain("blockUnknown ? 'alert-circle-outline' : 'ellipsis-vertical'");
    expect(body).toContain('blockUnknown ? colors.warning : colors.text');
  });

  it('меню чата приписывает причину к «Заблокировать»', () => {
    const body = slice(CHAT(), 'const blockLabel = isBlocked', 'const muteLabel');
    expect(body).toContain(': blockUnknown');
    expect(body).toContain("? 'Заблокировать (список запретов не прочитан)'");
  });
});

describe('ГРАНИЦА: пометка снимается сама', () => {
  it('после снятия запрета состояние перечитывается', () => {
    const body = slice(CHAT(), "const ok = await rateLimiter.unblockContact(peerB64);", "}, 'Не удалось разблокировать'");
    expect(body).toContain('setBlockUnknown(!rateLimiter.blockedListReadable());');
  });

  it('после постановки запрета — тоже', () => {
    const body = slice(CHAT(), 'const ok = await rateLimiter.blockContact(peerB64);', "}, 'Не удалось заблокировать'");
    expect(body).toContain('setBlockUnknown(!rateLimiter.blockedListReadable());');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: у `isBlocked` по-прежнему нет ответа «не знаю»', async () => {
    // Здесь хранилища нет вовсе, то есть список заведомо не прочитан — и
    // `whenReady` со своим повтором этого не меняет. `isBlocked` при этом
    // отвечает ровно то же, что про незаблокированного человека. Пока один
    // вопрос даёт на два разных мира один ответ, второй вопрос обязателен.
    await rateLimiter.whenReady();
    expect(rateLimiter.blockedListReadable()).toBe(false);
    expect(rateLimiter.isBlocked('A'.repeat(43))).toBe(false);
  });

  it('прежние две подписи и прежний значок запрета на месте', () => {
    const src = CHAT();
    // Отступы тут намеренно не закрепляются: это проверка того, что прежние
    // ветки живы, а не того, как их переносили по строкам.
    expect(src).toContain("'Контакт заблокирован'");
    expect(src).toContain("'Сообщение'");
    expect(src).toContain("name={isBlocked ? 'ban'");
    expect(src).toContain("'Заблокировать'");
  });

  it('слова те же, что на экране «Заблокированные»: правило одно', () => {
    expect(LIST()).toContain('Пока он не прочитан, запреты не действуют');
  });

  it('срезы вырезают место, а не весь файл', () => {
    const whole = CHAT().length;
    expect(EFFECT().length).toBeGreaterThan(80);
    expect(EFFECT().length).toBeLessThan(whole / 4);
    expect(EFFECT()).not.toContain('placeholder=');
  });

  it('снятие комментариев не съедает код', () => {
    expect(codeOnly('// blockedListReadable\nconst a = 1;')).toBe('const a = 1;');
    expect(codeOnly('const b = 2;')).toBe('const b = 2;');
  });
});
