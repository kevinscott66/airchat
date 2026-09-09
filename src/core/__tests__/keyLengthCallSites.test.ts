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

/**
 * Форма ключа в base64, записанная длиной вместо isPubKeyB64.
 *
 * v4.32.666. 43, 44 и 48 — это длины base64 от тридцати двух байт (без
 * выравнивания, с ним и с запасом на url-safe варианты). Ничто другое в этом
 * коде не измеряется числами 43…48, поэтому сравнение длины именно с ними —
 * это всегда переписанная заново проверка «похоже на ключ». Длины мало: под
 * «43…48 символов» подходит и строка из управляющих байтов, и невидимые метки
 * направления письма, и кириллица — ровно об этом написан pubKeyFormat.
 *
 * Ловится только там, где имя выражения говорит о ключе (Pub / Key / b64):
 * потолок на произвольный текст длиной 48 — законен.
 */
const BARE_PUB_B64_LENGTH =
  /[A-Za-z0-9_$.]*(?:[Pp]ub|[Kk]ey|[Bb]64)[A-Za-z0-9_$.]*\.length\s*(?:[<>]=?|===|!==|==|!=)\s*(?:43|44|48)\b/;

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

  it('форма ключа в base64 нигде не записана длиной', () => {
    const offenders = FILES.filter(
      (f) => f.key !== HOME && f.lines.some((l) => BARE_PUB_B64_LENGTH.test(l))
    ).map((f) => f.key);
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
    // Ровно те восемь проверок, что стояли в коде до круга 4.32.666.
    expect(
      BARE_PUB_B64_LENGTH.test(
        "if (typeof env.authorPubB64 !== 'string' || env.authorPubB64.length < 43 || env.authorPubB64.length > 48) return null;"
      )
    ).toBe(true);
    expect(BARE_PUB_B64_LENGTH.test('peerPubKeyB64.length < 43 ||')).toBe(true);
    expect(BARE_PUB_B64_LENGTH.test('peerPubKeyB64.length > 48')).toBe(true);
    expect(
      BARE_PUB_B64_LENGTH.test(
        "if (typeof contactPubB64 !== 'string' || contactPubB64.length < 43 || contactPubB64.length > 48) {"
      )
    ).toBe(true);
    expect(
      BARE_PUB_B64_LENGTH.test(
        "if (typeof senderPubB64 !== 'string' || senderPubB64.length < 43 || senderPubB64.length > 48) {"
      )
    ).toBe(true);
    expect(
      BARE_PUB_B64_LENGTH.test(
        "if (typeof env.viewerPubB64 !== 'string' || env.viewerPubB64.length < 43 || env.viewerPubB64.length > 48) return true;"
      )
    ).toBe(true);
    expect(
      BARE_PUB_B64_LENGTH.test(
        "if (typeof env.requesterPubB64 !== 'string' || env.requesterPubB64.length < 43 || env.requesterPubB64.length > 48) return true;"
      )
    ).toBe(true);
    expect(
      BARE_PUB_B64_LENGTH.test(
        "if (typeof r.peerPubB64 !== 'string' || r.peerPubB64.length < 43 || r.peerPubB64.length > 48) continue;"
      )
    ).toBe(true);
    // И равенство с 44 — та же самая проверка, записанная короче.
    expect(BARE_PUB_B64_LENGTH.test('if (pubB64.length !== 44) return null;')).toBe(true);
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
    // Потолок на произвольный текст — не утверждение о ключе.
    expect(BARE_PUB_B64_LENGTH.test('if (name.length > 48) return;')).toBe(false);
    expect(BARE_PUB_B64_LENGTH.test("if (r.text.length > 4096) continue;")).toBe(false);
    expect(BARE_PUB_B64_LENGTH.test('if (text.length > 4000) setError();')).toBe(false);
    // Правильная форма, разумеется, не ловится.
    expect(BARE_PUB_B64_LENGTH.test('if (!isPubKeyB64(env.authorPubB64)) return null;')).toBe(false);
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

  it('форму ключа проверяют общим правилом, а не в одном файле', () => {
    // Невырожденность: если isPubKeyB64 перестанут применять, запрет на
    // запись длиной станет пустым — запрещать будет нечего.
    const users = FILES.filter((f) => f.lines.some((l) => l.includes('isPubKeyB64'))).map(
      (f) => f.key
    );
    expect(users).toContain(HOME);
    expect(users).toContain('core/social/groupMessaging.ts');
    expect(users).toContain('core/social/scheduledMessages.ts');
    expect(users).toContain('core/social/storyEnvelope.ts');
    expect(users).toContain('core/security/rateLimiter.ts');
    expect(users).toContain('core/social/callService.ts');
    expect(users.length).toBeGreaterThanOrEqual(12);
  });

  it('разбор ключа из base64 идёт через pubKeyFormat не в одном файле', () => {
    const users = FILES.filter((f) =>
      f.lines.some((l) => l.includes('publicKeyFromB64') || l.includes('didFromPubB64'))
    ).map((f) => f.key);
    expect(users.length).toBeGreaterThanOrEqual(12);
  });
});
