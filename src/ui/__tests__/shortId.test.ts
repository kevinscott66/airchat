/**
 * Сокращённая подпись личности: одна на все экраны, и она ничего не выдумывает.
 *
 * v4.32.425.
 */
import { identityBody, shortIdentity, SHORT_ID_KEEP } from '../identity/shortId';

const DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const PUB = 'sYk1v0Qd7mJ2pN8xR4aT6cW9zB3eH5gL7iO0uY2qA4E=';

describe('identityBody', () => {
  it('приставка did:key: снимается — в ней нет различий', () => {
    expect(identityBody(DID)).toBe('z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
  });

  it('чужой формат не трогается', () => {
    expect(identityBody(PUB)).toBe(PUB);
    expect(identityBody('grp:abcdef')).toBe('grp:abcdef');
    expect(identityBody('')).toBe('');
  });
});

describe('shortIdentity', () => {
  it('показывает оба конца ключа, а не одну приставку', () => {
    // Ровно это и было сломано: `did.slice(0, 12) + '…'` — это `did:key:z6Mk…`
    // у ВСЕХ, потому что z6Mk — это multicodec Ed25519, а не чей-то ключ.
    expect(shortIdentity(DID)).toBe('z6Mkha…ta2doK');
    expect(shortIdentity(PUB)).toBe('sYk1v0…2qA4E=');
  });

  it('два разных человека подписаны по-разному', () => {
    const a = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const b = 'did:key:z6MkfZq4rTvW8yNhLpX2dGcB5eJmS7uA1oQ3iK9nVxYtHrDe';
    expect(shortIdentity(a)).not.toBe(shortIdentity(b));
  });

  it('короткое значение не удлиняется и знаки не повторяются', () => {
    // `slice(0, 14)…slice(-6)` от 'z6MkhaXg' давало 'z6MkhaXg…MkhaXg':
    // строку длиннее исходной, где хвост взят из головы.
    for (const short of ['z6MkhaXg', 'abc', 'a', 'abcdefghijklm']) {
      const out = shortIdentity(short);
      expect(out.length).toBeLessThanOrEqual(short.length);
      expect(out).toBe(short);
    }
  });

  it('многоточие ставится, только если что-то выброшено', () => {
    const exact = 'x'.repeat(SHORT_ID_KEEP * 2 + 1);
    expect(shortIdentity(exact)).toBe(exact);
    expect(shortIdentity(exact + 'y')).toContain('…');
  });

  it('сокращение никогда не длиннее исходного', () => {
    for (let n = 0; n < 60; n++) {
      const s = 'k'.repeat(n);
      expect(shortIdentity(s).length).toBeLessThanOrEqual(s.length);
    }
  });

  it('число знаков задаётся, и оба конца равны', () => {
    expect(shortIdentity(DID, 8)).toBe('z6MkhaXg…EGta2doK');
    expect(shortIdentity(DID, 10)).toBe('z6MkhaXgBZ…nnEGta2doK');
    // Нулевой и отрицательный запас — это не «показать пусто», а один знак:
    // подпись без единого знака никого ни от кого не отличает.
    expect(shortIdentity(DID, 0)).toBe('z…K');
    expect(shortIdentity(DID, -5)).toBe('z…K');
  });

  it('не строка и пустая строка — пустая подпись, а не «undefined»', () => {
    for (const bad of [null, undefined, 0, NaN, {}, []]) {
      expect(shortIdentity(bad)).toBe('');
    }
    expect(shortIdentity('')).toBe('');
  });
});
