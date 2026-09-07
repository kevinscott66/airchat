/**
 * Выгрузка облачной копии возвращает ленту на место (v4.32.625).
 *
 * `uploadCloudVault` закрывает две базы, чтобы забрать их файлы целиком. Одна
 * из них открывается сама: `closeLocalDatabase` только обнуляет dbPromise. А
 * `closeFeedStorage` стирает ещё и номер профиля, и после него `ensureStorage`
 * бросает `feed_storage_profile_unset` на каждом запросе. Бросок гасит
 * `loadFeedPosts` и возвращает null — то есть человек, отправивший копию из
 * настроек, видел «Зашифрованная копия отправлена в облако», переходил в ленту
 * и находил её пустой. До перезапуска приложения.
 *
 * Здесь же — единицы измерения у потолка расшифровки: второй параметр
 * decodeBase64 сравнивается с `bytes.length`, а туда уезжало число символов.
 */
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'cloudVault.ts'), 'utf8');
const FEED = fs.readFileSync(
  path.join(__dirname, '..', '..', 'social', 'feedService.ts'),
  'utf8',
);

/** Тело функции от заголовка до первой закрывающей скобки в нулевой колонке. */
function bodyOf(source: string, head: string): string {
  const from = source.indexOf(head);
  expect(from).toBeGreaterThan(0);
  const to = source.indexOf('\n}\n', from);
  expect(to).toBeGreaterThan(from);
  return source
    .slice(from, to)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('выгрузка копии не оставляет ленту закрытой', () => {
  const upload = () => bodyOf(SRC, 'export async function uploadCloudVault(');

  it('номер профиля снимается до закрытия ленты', () => {
    const b = upload();
    const read = b.indexOf('const feedPid = feedProfileId();');
    const close = b.indexOf('await closeFeedStorage();');
    expect(read).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(read);
  });

  it('лента открывается обратно в finally — и на отказе тоже', () => {
    const b = upload();
    const close = b.indexOf('await closeFeedStorage();');
    const fin = b.indexOf('} finally {');
    const rebind = b.indexOf('await setFeedProfileContext(feedPid);');
    expect(fin).toBeGreaterThan(close);
    expect(rebind).toBeGreaterThan(fin);
    expect(b).toContain("log.warn('cloud_vault_feed_rebind_failed'");
  });

  it('восстановление копии, наоборот, ленту не открывает', () => {
    // Восстановление зовут только из онбординга: номер профиля ленте
    // выставит обычный вход в аккаунт сразу после него.
    const b = bodyOf(SRC, 'export async function restoreCloudVault(');
    expect(b).toContain('await closeFeedStorage();');
    expect(b).not.toContain('setFeedProfileContext');
  });

  it('лента отдаёт свой номер наружу', () => {
    expect(FEED).toContain('export function feedProfileId(): number | null {');
    expect(FEED).toContain('return currentProfileId;');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: выгрузка всё ещё снимает снимок и шлёт его наверх', () => {
    const b = upload();
    expect(b).toContain('await snapshotAccountVault(mnemonic, profileState)');
    expect(b).toContain("log.info('cloud_vault_uploaded'");
  });
});

describe('потолок расшифровки считается в байтах', () => {
  it('в decodeBase64 уезжает предел в байтах, а не в символах', () => {
    expect(SRC).toContain(
      'decodeBase64(envelope.blobB64, CLOUD_VAULT_MAX_BYTES + CLOUD_VAULT_BLOB_OVERHEAD)',
    );
    expect(SRC).not.toContain('decodeBase64(envelope.blobB64, CLOUD_VAULT_MAX_BYTES * 2)');
    expect(SRC).toContain('const CLOUD_VAULT_BLOB_OVERHEAD = 64;');
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: соседний вызов с байтовым пределом на месте', () => {
    expect(SRC).toContain('decodeBase64(envelope.saltB64, 16)');
  });
});
