/**
 * Исходящее мимо непрочитанного запрета (v4.32.1044).
 *
 * ДЕФЕКТ. У `rateLimiter.isBlocked` нет ответа «не знаю»: не подняв список с
 * диска, он говорит «не заблокирован» про кого угодно. Приём эту разницу
 * спрашивает с v4.32.795 (`blockedListReadable`), а вся исходящая половина —
 * нет. Три места звали `isBlocked` сразу после `whenReady`, который даёт
 * чтению второй заход, но успеха не обещает.
 *
 * ЦЕНА. Каждое из трёх уносит наружу то, что запрет и прятал. Отметка о
 * прочтении показывает заблокированному, что его сообщения всё ещё читают, —
 * ровно то, ради чего её и перестали слать в v4.32.171. `canReachPeer`
 * пропускает служебные конверты: мой профиль, имя, фотографию, настройки
 * присутствия. Отправка текста доносит до него сообщение целиком. Отозвать
 * ушедшее нечем.
 *
 * ПРАВКА. Все три спрашивают, прочитан ли список, и при «нет» отказывают.
 * Потери при этом никакой: отметка повторится при следующем открытии
 * переписки, служебный конверт не помечается как отправленный, а текст
 * остаётся в поле ввода и отказ назван человеку своими словами.
 *
 * ГРАНИЦЫ. Прочитанный список решает по-прежнему; поведение `canReachPeer`
 * проверяется вживую в sendGate.test.ts — здесь исходник, потому что
 * MessagingService в jest не поднимается.
 */
import * as fs from 'fs';
import * as path from 'path';

const read = (...p: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** Строки без комментариев: пояснение не должно подменять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const MESSAGING = codeOnly(read('messaging.ts'));
const GATE = codeOnly(read('sendGate.ts'));
const LIMITER = codeOnly(read('..', 'security', 'rateLimiter.ts'));

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('отметка о прочтении', () => {
  const body = (): string =>
    slice(MESSAGING, '  async sendReadReceipt(', '  async getMessages(');

  it('не уходит, пока список запретов не прочитан', () => {
    expect(body()).toContain('rateLimiter.blockedListReadable()');
  });

  it('проверка читаемости стоит ВЫШЕ вопроса «заблокирован ли»', () => {
    // Порядок тут и есть правка: ниже `isBlocked` ответил бы «нет» и отметка
    // ушла бы раньше, чем кто-нибудь спросил про читаемость.
    const b = body();
    expect(b.indexOf('blockedListReadable()')).toBeGreaterThan(0);
    expect(b.indexOf('blockedListReadable()')).toBeLessThan(b.indexOf('isBlocked('));
  });

  it('ГРАНИЦА: прочитанный список решает по-прежнему', () => {
    expect(body()).toContain('if (rateLimiter.isBlocked(contactPubB64)) return;');
  });
});

describe('отправка текста', () => {
  const body = (): string =>
    slice(MESSAGING, '  async sendMessageResult(', '  private async sendMessageWork(');

  it('отказывает при непрочитанном списке, и отказ назван человеку', () => {
    const b = body();
    expect(b).toContain('rateLimiter.blockedListReadable()');
    expect(b).toContain("code: 'BLOCK_LIST_UNREADABLE'");
    // Отказ объяснён отсюда — экран не добавляет поверх собственное
    // «Попробуйте ещё раз» (см. `explained`, v4.32.860).
    const branch = slice(b, "code: 'BLOCK_LIST_UNREADABLE'", 'isBlocked(contactPubB64)');
    expect(branch).toContain('retryable: true');
    expect(branch).toContain("outcome: 'refused'");
    expect(branch).toContain('explained: true');
  });

  it('проверка читаемости стоит ВЫШЕ вопроса «заблокирован ли»', () => {
    const b = body();
    expect(b.indexOf('blockedListReadable()')).toBeGreaterThan(0);
    expect(b.indexOf('blockedListReadable()')).toBeLessThan(
      b.indexOf('isBlocked(contactPubB64)'),
    );
  });

  it('ГРАНИЦА: отказ по блокировке остался отдельным и неповторяемым', () => {
    // Два отказа не сливаются в один текст: заблокированному контакту повтор
    // не поможет, а занятой базе — поможет.
    const b = body();
    expect(b).toContain("code: 'BLOCKED_CONTACT'");
    const blocked = slice(b, "code: 'BLOCKED_CONTACT'", "outcome: 'refused'");
    expect(blocked).toContain('retryable: false');
  });
});

describe('служебные конверты', () => {
  it('«дойдёт ли» спрашивает читаемость и отвечает «нет» при отказе', () => {
    expect(GATE).toContain('if (!rateLimiter.blockedListReadable()) return false;');
    expect(GATE.indexOf('blockedListReadable()')).toBeGreaterThan(0);
    expect(GATE.indexOf('blockedListReadable()')).toBeLessThan(GATE.indexOf('isBlocked('));
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('isBlocked по-прежнему двузначен, а blockedListReadable отвечает про чтение', () => {
    // Исчезни разница — проверять станет нечего, но и повод отпадёт.
    expect(LIMITER).toContain('isBlocked(');
    expect(LIMITER).toContain('blockedListReadable(): boolean {');
    expect(LIMITER).toContain('return !this.loadFailed;');
  });

  it('whenReady даёт чтению второй заход и на этом останавливается', () => {
    const body = slice(LIMITER, 'async whenReady(): Promise<void> {', '  }');
    expect(body).toContain('await this.retryLoad()');
  });
});
