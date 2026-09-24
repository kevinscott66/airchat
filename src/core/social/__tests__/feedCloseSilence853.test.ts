/**
 * «Выйти и удалить данные» оставляло ключ стёртой личности в памяти навсегда
 * (v4.32.853).
 *
 * Дефект. `closeFeedStorage` гасил таймер очереди постов и обнулял его пару
 * ключей, а второй таймер модуля — отложенных комментариев — не трогал вовсе.
 *
 * Цена. `wipeLocalWallet` — это «выйти и удалить данные». Он останавливает
 * трансляцию геопозиции, планировщик, переписку, звонки, чистит буфер обмена
 * и закрывает базы. После всего этого таймер отложенных комментариев остаётся
 * заведённым, держа `commentRetryPair` — пару ключей только что стёртого
 * аккаунта. Через полминуты он просыпается и идёт читать стёртую базу. Стёртая
 * база отвечает «не прочиталось», а на такой ответ `scheduleCommentOutboxRetry`
 * заводит себя заново — и это намеренно, иначе один сбой чтения бросил бы
 * очередь до перезапуска. Получался вечный круг: приватный ключ личности,
 * которую человек попросил стереть, жил в памяти до закрытия приложения и
 * каждые полминуты пытался ею отправлять.
 *
 * Правка. Закрытие базы глушит ОБА таймера и обнуляет ОБЕ пары ключей.
 * Проверка написана правилом, а не перечнем строк: любая будущая пара
 * «таймер + ключ» в этом модуле обязана гаситься там же. Перечень строк
 * поймал бы сегодняшний случай и пропустил завтрашний — а он тут ровно
 * второй по счёту.
 *
 * Границы набора. `feedService` в наборе не поднимается: модуль тянет
 * expo-file-system, SQLite и хранилище профилей, и его импорт рвёт окружение.
 * Поэтому правило проверяется по исходнику.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8');

const FEED = read('core', 'social', 'feedService.ts');
const WIPE = read('core', 'wallet', 'wipeLocalWallet.ts');

/** Только код: пояснение не должно само удовлетворять проверку. */
const codeOnly = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** Тело функции от заголовка до закрывающей скобки нулевого отступа. */
function bodyOf(src: string, header: string): string {
  const from = src.indexOf(header);
  expect(from).toBeGreaterThan(0);
  const to = src.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return codeOnly(src.slice(from, to));
}

const CLOSE = (): string => bodyOf(FEED, 'export async function closeFeedStorage(');

/** Модульные `let` — то, что переживает закрытие базы, если его не обнулить. */
function moduleLets(src: string): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const line of codeOnly(src).split('\n')) {
    const m = /^let ([A-Za-z0-9_]+):\s*([^=]+?)\s*=/.exec(line);
    if (m) out.push({ name: m[1], type: m[2] });
  }
  return out;
}

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('«не прочиталось» заводит таймер комментариев заново — круг вечный', () => {
    const body = bodyOf(FEED, 'function scheduleCommentOutboxRetry(');
    expect(body).toContain('if (q === null) {');
    expect(body).toContain('scheduleCommentOutboxRetry(p, delayMs);');
  });

  it('стирание данных закрывает базу ленты именно этим вызовом', () => {
    const code = codeOnly(WIPE);
    expect(code).toContain('await closeFeedStorage();');
    // Другого способа заглушить таймеры ленты у стирания нет: весь расчёт на
    // то, что закрытие базы само за собой приберёт.
    expect(code).not.toContain('clearCommentOutboxTimer');
    expect(code).not.toContain('commentRetryPair');
  });

  it('у таймера комментариев своя пара ключей, и она переживает закрытие', () => {
    expect(codeOnly(FEED)).toContain('let commentRetryPair: KeyPairBytes | null = null;');
    expect(bodyOf(FEED, 'function scheduleCommentOutboxRetry(')).toContain('commentRetryPair = pair;');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('таймер очереди постов при закрытии гасился и раньше', () => {
    // Если бы не гасился и он, проверка ниже краснела бы по любой причине, а
    // не по той, ради которой написана.
    expect(CLOSE()).toContain('clearFeedRetryTimer();');
    expect(CLOSE()).toContain('feedRetryPair = null;');
  });

  it('очередь комментариев не теряется: её оживляет запуск профиля', () => {
    // Гасить таймер можно только потому, что очередь лежит на диске и её есть
    // чем поднять. Иначе правка меняла бы вечную попытку на её отсутствие.
    expect(codeOnly(FEED)).toContain('export function resumeCommentOutbox(pair: KeyPairBytes): void {');
    expect(bodyOf(FEED, 'export function resumeCommentOutbox(')).toContain('scheduleCommentOutboxRetry(');
  });

  it('модульных таймеров и пар ключей ровно столько, сколько мы думаем', () => {
    const lets = moduleLets(FEED);
    const timers = lets.filter((l) => /ReturnType<typeof setTimeout>/.test(l.type)).map((l) => l.name);
    const pairs = lets.filter((l) => /KeyPairBytes/.test(l.type)).map((l) => l.name);
    expect(timers.sort()).toEqual(['commentOutboxTimer', 'retryTimer']);
    expect(pairs.sort()).toEqual(['commentRetryPair', 'feedRetryPair']);
  });
});

describe('закрытие базы глушит всё, что может её тронуть', () => {
  it('каждый таймер модуля гасится при закрытии', () => {
    const body = CLOSE();
    const timers = moduleLets(FEED)
      .filter((l) => /ReturnType<typeof setTimeout>/.test(l.type))
      .map((l) => l.name);
    const armed = timers.filter((name) => {
      // Гасят либо своим `clearXxx()`, либо присваиванием null прямо здесь.
      const clearer = new RegExp(`function (clear[A-Za-z0-9_]*)\\(\\): void \\{\\n\\s*if \\(${name}\\)`);
      const fn = clearer.exec(FEED)?.[1];
      if (fn && body.includes(`${fn}();`)) return false;
      return !body.includes(`${name} = null;`);
    });
    expect(armed).toEqual([]);
  });

  it('каждая пара ключей модуля обнуляется при закрытии', () => {
    const body = CLOSE();
    const kept = moduleLets(FEED)
      .filter((l) => /KeyPairBytes/.test(l.type))
      .map((l) => l.name)
      .filter((name) => !body.includes(`${name} = null;`));
    expect(kept).toEqual([]);
  });

  it('таймер комментариев гасится до закрытия соединения, а не после', () => {
    // После `await active.close()` было бы поздно: окно между закрытием и
    // гашением — ровно то, в которое таймер и просыпается.
    const body = CLOSE();
    expect(body.indexOf('clearCommentOutboxTimer();')).toBeGreaterThan(0);
    expect(body.indexOf('clearCommentOutboxTimer();')).toBeLessThan(body.indexOf('await active.close();'));
  });
});
