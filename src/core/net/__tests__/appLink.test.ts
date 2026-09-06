import {
  APP_LINK_MAX,
  DEFAULT_LINK_BASE,
  buildContactLink,
  buildDmLink,
  buildGroupLink,
  buildPostLink,
  isAppLink,
  linkBase,
  parseAppLink,
  webForm,
} from '../appLink';

/** 32 байта — настоящий по форме ключ Ed25519 в обычном base64. */
const PUB = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)).toString('base64');

describe('appLink', () => {
  describe('адрес меняется в одном месте', () => {
    const saved = process.env.EXPO_PUBLIC_LINK_BASE;
    afterEach(() => {
      if (saved === undefined) delete process.env.EXPO_PUBLIC_LINK_BASE;
      else process.env.EXPO_PUBLIC_LINK_BASE = saved;
    });

    it('по умолчанию собирается под адресом из константы', () => {
      delete process.env.EXPO_PUBLIC_LINK_BASE;
      expect(linkBase()).toBe(DEFAULT_LINK_BASE);
      expect(buildPostLink('f_1_ab').web).toBe(`${DEFAULT_LINK_BASE}/l/post/f_1_ab`);
    });

    it('переменная сборки старше константы, хвостовой слэш срезается', () => {
      process.env.EXPO_PUBLIC_LINK_BASE = 'https://new.example.org/';
      expect(buildPostLink('f_1_ab').web).toBe('https://new.example.org/l/post/f_1_ab');
    });

    it('негодная переменная не превращает ссылки в мусор', () => {
      process.env.EXPO_PUBLIC_LINK_BASE = 'не адрес';
      expect(linkBase()).toBe(DEFAULT_LINK_BASE);
    });

    it('ссылка, выданная под ПРЕЖНИМ адресом, читается после смены', () => {
      process.env.EXPO_PUBLIC_LINK_BASE = 'https://new.example.org';
      // Ровно та строка, что была разослана людям до смены домена.
      expect(parseAppLink('https://air.dobropalm.tech/l/post/f_1_ab')).toEqual({
        kind: 'post',
        postId: 'f_1_ab',
      });
      // А новая собирается уже под новым адресом.
      expect(buildPostLink('f_1_ab').web).toBe('https://new.example.org/l/post/f_1_ab');
    });
  });

  describe('туда и обратно', () => {
    it('переписка с собеседником', () => {
      const l = buildDmLink(PUB);
      expect(parseAppLink(l.app)).toEqual({ kind: 'dm', peerPubB64: PUB });
      expect(parseAppLink(l.web)).toEqual({ kind: 'dm', peerPubB64: PUB });
    });

    it('сообщение в переписке', () => {
      const l = buildDmLink(PUB, 'a-b-c');
      expect(parseAppLink(l.app)).toEqual({ kind: 'dm', peerPubB64: PUB, msgId: 'a-b-c' });
      expect(parseAppLink(l.web)).toEqual({ kind: 'dm', peerPubB64: PUB, msgId: 'a-b-c' });
    });

    it('сообщение в группе', () => {
      const l = buildGroupLink('g-1', 'm-2');
      expect(parseAppLink(l.app)).toEqual({ kind: 'group', groupId: 'g-1', msgId: 'm-2' });
      expect(parseAppLink(l.web)).toEqual({ kind: 'group', groupId: 'g-1', msgId: 'm-2' });
    });

    it('профиль', () => {
      const l = buildContactLink(PUB);
      expect(parseAppLink(l.app)).toEqual({ kind: 'contact', peerPubB64: PUB });
      expect(parseAppLink(l.web)).toEqual({ kind: 'contact', peerPubB64: PUB });
    });

    it('публикация', () => {
      const l = buildPostLink('f_1757000000000_abc');
      expect(parseAppLink(l.app)).toEqual({ kind: 'post', postId: 'f_1757000000000_abc' });
      expect(parseAppLink(l.web)).toEqual({ kind: 'post', postId: 'f_1757000000000_abc' });
    });
  });

  describe('ключ в пути', () => {
    it('в собранной ссылке нет ни одного слэша от base64', () => {
      // Обычный base64 содержит '/', а путь режется по '/': ссылка приходила бы
      // получателю обрезанной.
      const seg = buildDmLink(PUB).app.slice('airchat://dm/'.length);
      expect(seg).not.toContain('/');
      expect(seg).not.toContain('+');
      expect(seg).not.toContain('=');
    });

    it('прежняя запись ключа (обычный base64 через процент) ещё читается', () => {
      const old = `airchat://dm/${encodeURIComponent(PUB)}/msg/x1`;
      expect(parseAppLink(old)).toEqual({ kind: 'dm', peerPubB64: PUB, msgId: 'x1' });
    });

    it('did:key в пути ведёт в тот же профиль', () => {
      const did = require('../../identity/did').didFromPubB64(PUB) as string;
      expect(parseAppLink(`airchat://contact/${did}`)).toEqual({ kind: 'contact', peerPubB64: PUB });
    });

    it('строка не той длины ключом не считается', () => {
      expect(parseAppLink('airchat://dm/abc')).toBeNull();
    });
  });

  describe('прежние формы остались рабочими', () => {
    it('приглашение в группу', () => {
      expect(parseAppLink('airchat://join-group/eyJpZCI6MX0')).toEqual({
        kind: 'joinGroup',
        payload: 'eyJpZCI6MX0',
      });
    });

    it('вкладка', () => {
      expect(parseAppLink('airchat://tab/feed')).toEqual({ kind: 'tab', tab: 'feed' });
    });
  });

  describe('чужое и кривое', () => {
    it.each([
      ['не строка', 123],
      ['пустая строка', ''],
      ['другая схема', 'tg://post/1'],
      ['https без нашего префикса', 'https://air.dobropalm.tech/post/f_1'],
      ['https без пути', 'https://air.dobropalm.tech'],
      ['неизвестная форма', 'airchat://wallet/1'],
      ['лишний хвост', 'airchat://post/f_1/extra'],
      ['msg без имени сообщения', 'airchat://group/g1/msg'],
      ['кривая процент-запись', 'airchat://post/%E0%A4%A'],
    ])('%s — не наша ссылка', (_name, input) => {
      expect(parseAppLink(input as string)).toBeNull();
    });

    it('строка длиннее потолка отбрасывается без разбора', () => {
      expect(parseAppLink(`airchat://post/${'a'.repeat(APP_LINK_MAX)}`)).toBeNull();
    });

    it('isAppLink отвечает тем же, чем и разбор', () => {
      expect(isAppLink('https://example.com/l/post/f_1')).toBe(true);
      expect(isAppLink('https://example.com/blog/post')).toBe(false);
    });
  });

  describe('готовая ссылка переводится в https-форму', () => {
    const saved = process.env.EXPO_PUBLIC_LINK_BASE;
    afterEach(() => {
      if (saved === undefined) delete process.env.EXPO_PUBLIC_LINK_BASE;
      else process.env.EXPO_PUBLIC_LINK_BASE = saved;
    });

    it('приглашение в группу уезжает под текущим адресом и читается обратно', () => {
      delete process.env.EXPO_PUBLIC_LINK_BASE;
      const web = webForm('airchat://join-group/AAAA-_BB');
      expect(web).toBe(`${DEFAULT_LINK_BASE}/l/join-group/AAAA-_BB`);
      expect(parseAppLink(web)).toEqual({ kind: 'joinGroup', payload: 'AAAA-_BB' });
    });

    it('после смены адреса собирается под новым', () => {
      process.env.EXPO_PUBLIC_LINK_BASE = 'https://new.example.org';
      expect(webForm('airchat://join-group/AAAA')).toBe('https://new.example.org/l/join-group/AAAA');
    });

    it('чужая строка возвращается как есть', () => {
      expect(webForm('https://example.com/x')).toBe('https://example.com/x');
      expect(webForm('не ссылка')).toBe('не ссылка');
    });
  });
});
