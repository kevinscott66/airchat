/**
 * v4.32.303. Отзыв ссылки держится ровно на одном решении: пускать ли того,
 * кто предъявил токен. Ошибка в любую сторону стоит дорого — «пускать при
 * отсутствии токена» превращает сброс в пустую кнопку, а «не пускать, когда
 * сверять не с чем» закрывает вход во все группы, созданные до этой версии.
 */
import { randomBytes } from '@noble/hashes/utils.js';
import {
  INVITE_TOKEN_BYTES,
  decideInviteToken,
  isInviteToken,
  makeInviteToken,
} from '../groupInviteToken';

describe('makeInviteToken', () => {
  it('22 символа base64url — без «+», «/» и «=»', () => {
    const t = makeInviteToken(randomBytes);
    expect(t).toHaveLength(22);
    expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isInviteToken(t)).toBe(true);
  });

  it('байты берутся из переданного источника целиком', () => {
    const asked: number[] = [];
    const t = makeInviteToken((n) => {
      asked.push(n);
      return new Uint8Array(n).fill(0xff);
    });
    expect(asked).toEqual([INVITE_TOKEN_BYTES]);
    // 16 байт 0xff → base64 '////////////////////' → base64url '____...'.
    expect(t).toBe('_____________________w');
  });

  it('два токена подряд не совпадают', () => {
    expect(makeInviteToken(randomBytes)).not.toBe(makeInviteToken(randomBytes));
  });

  it('источник, отдавший не столько байт, — ошибка, а не короткий токен', () => {
    // Молча укоротить токен значило бы ослабить его, не сказав об этом никому.
    expect(() => makeInviteToken(() => new Uint8Array(4))).toThrow('invite_token_bad_random');
  });
});

describe('isInviteToken', () => {
  it('отвергает всё, что не 22 символа base64url', () => {
    for (const bad of [
      null,
      undefined,
      42,
      '',
      'коротко',
      `${makeInviteToken(randomBytes)}x`,
      'AAAAAAAAAAAAAAAAAAAA==', // паддинг
      'AAAAAAAAAAAAAAAAAAAA+/', // не base64url
      'AAAAAAAAAAAAAAAAAAAA ', // пробел
    ]) {
      expect(isInviteToken(bad)).toBe(false);
    }
  });
});

describe('decideInviteToken', () => {
  const mine = makeInviteToken(randomBytes);
  const other = makeInviteToken(randomBytes);

  it('свой токен предъявлен — пускаем', () => {
    expect(decideInviteToken({ knownToken: mine, presented: mine })).toBe('ok');
  });

  it('старый токен после сброса — отзыв', () => {
    expect(decideInviteToken({ knownToken: other, presented: mine })).toBe('revoked');
  });

  it('токена в ссылке нет, а у нас есть — отзыв, а не поблажка', () => {
    // Иначе отзыв обходился бы вырезанием одного поля из ссылки: ровно так в
    // v4.32.259 обходился гейт «вход требует одобрения».
    for (const presented of [null, undefined, '', 'мусор']) {
      expect(decideInviteToken({ knownToken: mine, presented })).toBe('revoked');
    }
  });

  it('своего токена нет — сверять нечем, решают без нас', () => {
    // Группы, созданные до v4.32.303, и все обычные участники: токен есть
    // только у администраторов, он и есть право приглашать.
    for (const known of [null, undefined, '', 'не-токен']) {
      expect(decideInviteToken({ knownToken: known, presented: mine })).toBe('unenforceable');
      expect(decideInviteToken({ knownToken: known, presented: null })).toBe('unenforceable');
    }
  });
});
