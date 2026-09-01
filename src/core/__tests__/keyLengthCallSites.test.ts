/**
 * Храповик на длину ключа.
 *
 * v4.32.427. «Открытый ключ — тридцать два байта» было записано семнадцатью
 * строчками в двенадцати файлах, шестью разными способами, и число 32 стояло
 * в них голым литералом — тем же самым, каким рядом проверялась длина
 * симметричного ключа, DEK и секретного ключа. Три разных понятия, одно число:
 * читающий не может отличить их глазами, а правящий не может отличить их
 * поиском.
 *
 * Чинить копии бессмысленно, если восемнадцатую можно дописать завтра. Поэтому
 * запрещены сами формы, из которых копия складывается: сравнение длины с голым
 * числом и ручной разбор ключа из base64 в обход pubKeyFormat.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..');

/** Единственное место, где ключ разбирается из base64. */
const HOME = 'core/crypto/pubKeyFormat.ts';

/**
 * Единственное исключение: файл помечен @stable и защищён прямым указанием
 * пользователя — трогать его без отдельной просьбы нельзя. Долг записан здесь
 * намеренно, чтобы он был виден, а не забыт.
 */
const STABLE_EXEMPT = 'core/social/feedTransport.ts';

function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      collect(full, out);
      continue;
    }
    if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Строки файла без комментариев: упоминание в комментарии — не код. */
function codeLines(source: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*') || line.startsWith('{/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('*')) continue;
    out.push(line);
  }
  return out;
}

function relKey(full: string): string {
  return full.slice(SRC.length + 1).split('\\').join('/');
}

const FILES = collect(SRC).map((full) => ({
  key: relKey(full),
  lines: codeLines(readFileSync(full, 'utf8')),
}));

/**
 * Сравнение длины с голым 32 или 64.
 *
 * Ловятся только РАВЕНСТВА. `s.length <= 64` — это потолок на строку, он
 * законен и встречается в дюжине мест; `key.length !== 32` — это утверждение
 * о том, ЧТО ЭТО ЗА КЛЮЧ, и оно обязано быть названо именем.
 */
const BARE_LENGTH = /\.length\s*(?:!==|===|==|!=)\s*(?:32|64)\b/;

/** Ручной разбор открытого ключа из base64 в обход pubKeyFormat. */
const MANUAL_PUB_DECODE = /Buffer\.from\(\s*[A-Za-z0-9_$.]*(?:[Pp]ub|[Pp]ublicKey)[A-Za-z0-9_$.]*\s*,\s*'base64'\)/;

describe('длина ключа названа именем, а не числом', () => {
  it('файлы вообще нашлись — иначе проверка пустая', () => {
    expect(FILES.length).toBeGreaterThan(100);
    const keys = FILES.map((f) => f.key);
    expect(keys).toContain(HOME);
    expect(keys).toContain(STABLE_EXEMPT);
  });

  it('нигде длина не сравнивается с голым 32 или 64', () => {
    const offenders = FILES.filter((f) => f.lines.some((l) => BARE_LENGTH.test(l))).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('ключ не разбирается из base64 вручную', () => {
    const offenders = FILES.filter(
      (f) => f.key !== HOME && f.key !== STABLE_EXEMPT && f.lines.some((l) => MANUAL_PUB_DECODE.test(l))
    ).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('запрещённые формы действительно ловятся', () => {
    // Ровно те строки, что стояли в коде до этого круга.
    expect(BARE_LENGTH.test('if (publicKey.length !== 32) return null;')).toBe(true);
    expect(BARE_LENGTH.test('if (pk.length === 32) continue;')).toBe(true);
    expect(BARE_LENGTH.test('if (sig.length !== 64) return null;')).toBe(true);
    expect(
      MANUAL_PUB_DECODE.test("const pk = new Uint8Array(Buffer.from(c.peerPublicKey, 'base64'));")
    ).toBe(true);
    expect(MANUAL_PUB_DECODE.test("Buffer.from(contactPubB64, 'base64')")).toBe(true);
  });

  it('законные формы не ловятся', () => {
    // Потолки на длину строк и массивов — не утверждение о ключе.
    expect(BARE_LENGTH.test('typeof h === \'string\' && h.length <= 64')).toBe(false);
    expect(BARE_LENGTH.test('if (Object.keys(reactions).length >= 64) return;')).toBe(false);
    expect(BARE_LENGTH.test('if (r.status.length > 32) continue;')).toBe(false);
    expect(BARE_LENGTH.test('if (payload.length === 0) return null;')).toBe(false);
    expect(BARE_LENGTH.test('if (bytes.length !== 320) return null;')).toBe(false);
    // Кодирование в base64 — не разбор ключа.
    expect(MANUAL_PUB_DECODE.test("Buffer.from(pair.publicKey).toString('base64')")).toBe(false);
    // Чужие данные из base64 разбирать по-прежнему можно.
    expect(MANUAL_PUB_DECODE.test("Buffer.from(b64, 'base64').toString('utf8')")).toBe(false);
  });

  it('имена длин заведены и ими действительно пользуются', () => {
    // Невырожденность с другой стороны: если константы перестанут применяться,
    // предыдущие проверки станут пустыми и перестанут что-либо стеречь.
    const users = FILES.filter((f) =>
      f.lines.some(
        (l) =>
          l.includes('ED25519_PUBLIC_KEY_BYTES') ||
          l.includes('ED25519_SECRET_KEY_BYTES') ||
          l.includes('ED25519_SIGNATURE_BYTES') ||
          l.includes('SYMMETRIC_KEY_BYTES')
      )
    ).map((f) => f.key);
    expect(users).toContain(HOME);
    expect(users).toContain('core/crypto/keyManager.ts');
    expect(users).toContain('core/crypto/encrypt.ts');
    expect(users.length).toBeGreaterThanOrEqual(7);
  });

  it('разбор ключа из base64 идёт через pubKeyFormat не в одном файле', () => {
    const users = FILES.filter((f) =>
      f.lines.some((l) => l.includes('publicKeyFromB64') || l.includes('didFromPubB64'))
    ).map((f) => f.key);
    expect(users.length).toBeGreaterThanOrEqual(12);
  });
});
