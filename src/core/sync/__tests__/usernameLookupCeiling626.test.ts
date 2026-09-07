/**
 * Справочник юзернеймов читается с потолком (v4.32.626).
 *
 * `lookupSyncUsername` — единственный запрос модуля мимо `fetchSigned`, и
 * потолка на тело ответа у него не было: `response.json()` разбирал ответ
 * любого размера. Ходит он к серверу справочника без подписи, по одному
 * нажатию на @юзернейм в переписке, то есть по адресу, который называет
 * собеседник. Потолок тут не «оптимизация»: без него ответ на 96 МБ+ ложится
 * в память телефона целиком.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'syncApi.ts'), 'utf8');

/** Тело lookupSyncUsername без строк-комментариев. */
function lookup(): string {
  const from = SRC.indexOf('export async function lookupSyncUsername(');
  expect(from).toBeGreaterThan(0);
  const to = SRC.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return SRC.slice(from, to)
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

it('объявленная длина сверяется с потолком до разбора тела', () => {
  const b = lookup();
  const declared = b.indexOf(
    "const declared = parseInt(response.headers?.get?.('content-length') ?? '', 10);"
  );
  expect(declared).toBeGreaterThan(0);
  const guard = b.indexOf(
    'if (Number.isFinite(declared) && declared > MAX_SYNC_RESPONSE_BYTES) {'
  );
  expect(guard).toBeGreaterThan(declared);
  // Разбор — строго после двери, и она возвращает null, а не бросает.
  expect(b.indexOf('return null;', guard)).toBeGreaterThan(guard);
  expect(b.indexOf('await response.json()')).toBeGreaterThan(guard);
});

it('ПРОВЕРКА НЕ ПУСТАЯ: срок у запроса тоже на месте (v4.32.623)', () => {
  const b = lookup();
  expect(b).toContain('timeoutMs: SYNC_REQUEST_TIMEOUT_MS');
  expect(b).toContain('/v1/username/');
});

it('ПРОВЕРКА НЕ ПУСТАЯ: потолок — тот же, что у подписанных запросов', () => {
  // Идиома взята у fetchSigned, а не выдумана заново: имя одно на весь модуль.
  expect(SRC.split('MAX_SYNC_RESPONSE_BYTES').length - 1).toBeGreaterThanOrEqual(3);
  expect(SRC).toContain('const MAX_SYNC_RESPONSE_BYTES =');
});
