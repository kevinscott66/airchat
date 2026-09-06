// v4.32.614: срок запроса обязан покрывать чтение тела.
//
// Обвязка «запрос с таймером» была написана заново в пяти местах, и в двух —
// облачной копии аккаунта и привязке слов — таймер снимался, как только пришли
// заголовки. Дальше тело читалось без предела: сервер, замолчавший на середине
// мегабайтного архива, держал восстановление аккаунта до разрыва соединения.
// Здесь проверяется и сам общий помощник, и то, что оба места на него перешли.
import { readFileSync } from 'fs';
import { join } from 'path';

import { fetchWithDeadline, type FetchLike } from '../timedFetch';

function read(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8');
}

describe('запрос со сроком на весь обмен', () => {
  it('прерывает чтение тела, а не только ожидание заголовков', async () => {
    let aborted = false;
    const stalled: FetchLike = async (_input, init) => {
      const signal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('abort'));
          });
        }),
      } as unknown as Response;
    };

    await expect(fetchWithDeadline(
      'https://vault.example/v1/cloud-vault/x/get',
      { method: 'POST' },
      { timeoutMs: 20, fetchImpl: stalled, onTimeout: () => new Error('Облачный сервер не отвечает.') },
      (response) => response.json() as Promise<unknown>,
    )).rejects.toThrow('Облачный сервер не отвечает.');
    expect(aborted).toBe(true);
  });

  it('успешный ответ возвращает то, что прочитала переданная функция', async () => {
    const ok: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ envelope: 1 }) }) as unknown as Response;
    const body = await fetchWithDeadline('https://vault.example/x', {}, { timeoutMs: 1_000, fetchImpl: ok },
      async (response) => (await response.json()) as { envelope: number });
    expect(body.envelope).toBe(1);
  });

  it('ошибку не своего происхождения не подменяет текстом про срок', async () => {
    const broken: FetchLike = async () => { throw new Error('Network request failed'); };
    await expect(fetchWithDeadline('https://vault.example/x', {}, {
      timeoutMs: 1_000, fetchImpl: broken, onTimeout: () => new Error('не отвечает'),
    }, async () => null)).rejects.toThrow('Network request failed');
  });
});

describe('своих таймеров у сетевых мест не осталось', () => {
  for (const rel of ['backup/cloudVault.ts', 'backup/seedBinding.ts', 'social/publicPost.ts']) {
    it(`${rel} пользуется общим помощником`, () => {
      const src = read(rel);
      expect(src).not.toContain('new AbortController()');
      expect(src).toContain("from '../net/timedFetch'");
    });
  }

  it('облачный архив разбирается внутри срока, а не после возврата ответа', () => {
    const src = read('backup/cloudVault.ts');
    // Признак старой ошибки: `Response` уходил наружу, и тело читали уже без
    // таймера. Теперь наружу уходит разобранный конверт.
    expect(src).not.toContain('const response = await fetchCloud(');
    expect(src).toContain('const envelope = await fetchCloud(');
  });
});
