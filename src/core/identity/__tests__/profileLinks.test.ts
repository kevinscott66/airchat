/**
 * Привязки в конверте профиля (v4.32.575).
 *
 * Проверяется то, ради чего модуль и отделён от проверки подписей: разбор
 * недоверенного списка. Список приезжает от собеседника, и всё, что он может
 * прислать, здесь либо приводится к известному виду, либо отбрасывается.
 */
import {
  MAX_PROFILE_LINKS,
  findProfileLink,
  profileLinksKey,
  sanitizeProfileLinks,
} from '../profileLinks';
import { normalizeHandle, normalizeProofUrl, profileUrl, sameHandle } from '../linkPlatform';

const GIST = 'https://gist.github.com/0123456789abcdef0123456789abcdef';

describe('normalizeHandle', () => {
  it('принимает имя, @имя и адрес профиля', () => {
    expect(normalizeHandle('github', 'octocat')).toBe('octocat');
    expect(normalizeHandle('github', ' @octocat ')).toBe('octocat');
    expect(normalizeHandle('github', 'https://github.com/octocat')).toBe('octocat');
    expect(normalizeHandle('x', 'https://x.com/jack')).toBe('jack');
  });

  it('сохраняет регистр, но считает его незначащим при сравнении', () => {
    expect(normalizeHandle('github', 'Octocat')).toBe('Octocat');
    expect(sameHandle('Octocat', 'octocat')).toBe(true);
  });

  it('отбивает то, что сломало бы адрес', () => {
    expect(normalizeHandle('github', 'foo/../../evil')).toBeNull();
    expect(normalizeHandle('github', 'https://evil.com/octocat')).toBeNull();
    expect(normalizeHandle('x', 'слишкомдлинноеимя_16')).toBeNull();
    expect(normalizeHandle('x', '')).toBeNull();
    expect(normalizeHandle('x', 42)).toBeNull();
  });
});

describe('normalizeProofUrl', () => {
  it('приводит адрес публикации к каноническому виду', () => {
    expect(normalizeProofUrl('github', 'gist.github.com/octocat/0123456789ABCDEF0123456789abcdef')).toBe(GIST);
    expect(normalizeProofUrl('x', 'https://twitter.com/jack/status/20?s=1')).toBe('https://x.com/jack/status/20');
  });

  it('чужой адрес не становится адресом публикации', () => {
    expect(normalizeProofUrl('x', 'https://evil.com/jack/status/20')).toBeNull();
    expect(normalizeProofUrl('github', 'https://github.com/octocat')).toBeNull();
  });
});

describe('sanitizeProfileLinks', () => {
  it('разбирает нормальный список', () => {
    expect(sanitizeProfileLinks([{ p: 'github', h: 'octocat', u: GIST }])).toEqual([
      { p: 'github', h: 'octocat', u: GIST },
    ]);
  });

  it('негодный адрес не отменяет имени', () => {
    expect(sanitizeProfileLinks([{ p: 'x', h: 'jack', u: 'https://evil.com/x' }])).toEqual([
      { p: 'x', h: 'jack', u: null },
    ]);
  });

  it('отбрасывает записи без годного имени и незнакомые площадки', () => {
    expect(sanitizeProfileLinks([{ p: 'github', h: '../evil', u: GIST }])).toBeNull();
    expect(sanitizeProfileLinks([{ p: 'mastodon', h: 'jack', u: null }])).toBeNull();
    expect(sanitizeProfileLinks(['строка', null, 7])).toBeNull();
  });

  it('на площадку — одна запись, и не больше двух всего', () => {
    const many = sanitizeProfileLinks([
      { p: 'x', h: 'jack', u: null },
      { p: 'x', h: 'other', u: null },
      { p: 'github', h: 'octocat', u: null },
      { p: 'github', h: 'second', u: null },
    ]);
    expect(many).toEqual([
      { p: 'x', h: 'jack', u: null },
      { p: 'github', h: 'octocat', u: null },
    ]);
    expect(many?.length).toBeLessThanOrEqual(MAX_PROFILE_LINKS);
  });

  it('пусто и не-массив — это null, чтобы поле просто не появлялось', () => {
    expect(sanitizeProfileLinks([])).toBeNull();
    expect(sanitizeProfileLinks(null)).toBeNull();
    expect(sanitizeProfileLinks({ p: 'x', h: 'jack' })).toBeNull();
  });
});

describe('profileLinksKey', () => {
  it('различает изменившуюся привязку — иначе новая никому не уедет', () => {
    const a = sanitizeProfileLinks([{ p: 'x', h: 'jack', u: null }]);
    const b = sanitizeProfileLinks([{ p: 'x', h: 'jack', u: 'https://x.com/jack/status/20' }]);
    expect(profileLinksKey(a)).not.toBe(profileLinksKey(b));
    expect(profileLinksKey(a)).toBe(profileLinksKey(sanitizeProfileLinks([{ p: 'x', h: 'jack', u: null }])));
    expect(profileLinksKey(null)).toBe('');
  });
});

describe('findProfileLink / profileUrl', () => {
  it('находит площадку и собирает адрес профиля', () => {
    const links = sanitizeProfileLinks([{ p: 'github', h: 'octocat', u: null }]) ?? [];
    expect(findProfileLink(links, 'github')?.h).toBe('octocat');
    expect(findProfileLink(links, 'x')).toBeNull();
    expect(findProfileLink(null, 'x')).toBeNull();
    expect(profileUrl('github', 'octocat')).toBe('https://github.com/octocat');
    expect(profileUrl('x', 'jack')).toBe('https://x.com/jack');
    expect(profileUrl('x', '../evil')).toBeNull();
  });
});
