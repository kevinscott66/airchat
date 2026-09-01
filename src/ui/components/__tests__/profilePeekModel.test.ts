/**
 * Карточка профиля: кто перед нами и что об этом написано (v4.32.363).
 */

import { Buffer } from 'buffer';

import { peekIdentity, resolvePeer, shortDid } from '../profilePeekModel';
import { publicKeyToDidKey } from '../../../core/identity/did';

const PUB = new Uint8Array(32).fill(7);
const PUB_B64 = Buffer.from(PUB).toString('base64');
const DID = publicKeyToDidKey(PUB);

const OTHER = new Uint8Array(32).fill(9);
const OTHER_DID = publicKeyToDidKey(OTHER);

describe('resolvePeer', () => {
  it('по публичному ключу восстанавливает DID', () => {
    expect(resolvePeer(PUB_B64, null)).toEqual({ pubB64: PUB_B64, did: DID });
  });

  it('по DID восстанавливает публичный ключ', () => {
    expect(resolvePeer(null, DID)).toEqual({ pubB64: PUB_B64, did: DID });
  });

  it('ключ неверной длины отвергается, а не выдаётся за пира', () => {
    // Buffer.from не бросает на негодной base64 — молча отдаёт мусор, поэтому
    // проверять надо длину, а не отсутствие исключения.
    expect(resolvePeer(Buffer.from('короткий').toString('base64'), null)).toBeNull();
    expect(resolvePeer('это вообще не base64 !!!', null)).toBeNull();
  });

  it('негодный DID отвергается', () => {
    expect(resolvePeer(null, 'did:key:zНЕВЕРНО')).toBeNull();
    expect(resolvePeer(null, 'https://example.com')).toBeNull();
  });

  it('без обоих идентификаторов — null', () => {
    expect(resolvePeer(null, null)).toBeNull();
    expect(resolvePeer('', '')).toBeNull();
  });

  it('негодный ключ не мешает разобрать DID', () => {
    expect(resolvePeer('мусор', OTHER_DID)).toEqual({
      pubB64: Buffer.from(OTHER).toString('base64'),
      did: OTHER_DID,
    });
  });
});

describe('shortDid', () => {
  it('режет середину, приставку did:key: не показывает', () => {
    const s = shortDid(DID, 6);
    expect(s.startsWith('did:key:')).toBe(false);
    expect(s).toContain('…');
    expect(s.length).toBe(6 + 1 + 6);
  });

  it('короткую строку оставляет как есть', () => {
    expect(shortDid('did:key:zAbc', 8)).toBe('zAbc');
  });

  it('строку без приставки тоже принимает', () => {
    expect(shortDid('zAbc', 8)).toBe('zAbc');
  });
});

describe('peekIdentity', () => {
  it('свой профиль подписан своим', () => {
    const id = peekIdentity({ contact: null, did: DID, isSelf: true });
    expect(id.hint).toBe('Это ваш профиль');
  });

  it('добавленный руками — «В ваших контактах», без предложения добавить', () => {
    const id = peekIdentity({
      contact: { displayName: 'Аня' },
      did: DID,
      isSelf: false,
    });
    expect(id.inContacts).toBe(true);
    expect(id.hint).toBe('В ваших контактах');
    expect(id.title).toBe('Аня');
    expect(id.contactName).toBe('Аня');
    expect(id.initials).toBe('А');
  });

  it('implicit-строка контактом не считается — иначе добавить человека нечем', () => {
    // Строка создаётся сама при первой переписке с незнакомцем и в «Контактах»
    // не показывается. Карточка считала контактом любую найденную строку и
    // прятала единственную кнопку «Добавить в контакты».
    const id = peekIdentity({
      contact: { displayName: '', implicit: true },
      did: DID,
      isSelf: false,
    });
    expect(id.inContacts).toBe(false);
    expect(id.hint).toBe('Не в контактах — вы переписывались');
  });

  it('незнакомец без строки — просто не в контактах', () => {
    const id = peekIdentity({ contact: null, did: DID, isSelf: false });
    expect(id.inContacts).toBe(false);
    expect(id.hint).toBe('Не в контактах');
  });

  it('безымянный не становится «Контактом»: заглушка из DID различает людей', () => {
    const a = peekIdentity({ contact: null, did: DID, isSelf: false });
    const b = peekIdentity({ contact: null, did: OTHER_DID, isSelf: false });
    expect(a.named).toBe(false);
    expect(a.contactName).not.toBe(b.contactName);
    expect(a.contactName).toBe(shortDid(DID, 6));
    // В шапке — «Без имени»: DID показан отдельной строкой ниже.
    expect(a.title).toBe('Без имени');
  });

  it('у безымянного на аватаре вопрос, а не общая для всех буква', () => {
    // did:key всех ключей Ed25519 начинается одинаково — инициал был бы «Z»
    // у каждого встречного.
    expect(peekIdentity({ contact: null, did: DID, isSelf: false }).initials).toBe('?');
  });

  it('подсказанное имя используется, когда своего у контакта нет', () => {
    const id = peekIdentity({
      contact: { displayName: '  ', implicit: true },
      fallbackName: 'Аня из ленты',
      did: DID,
      isSelf: false,
    });
    expect(id.title).toBe('Аня из ленты');
    expect(id.contactName).toBe('Аня из ленты');
    expect(id.named).toBe(true);
  });

  it('местная подпись важнее подсказанного имени', () => {
    // Подсказка приходит из чужого поста, то есть её выбирает автор.
    const id = peekIdentity({
      contact: { displayName: 'Аня' },
      fallbackName: 'Мама',
      did: DID,
      isSelf: false,
    });
    expect(id.title).toBe('Аня');
  });

  it('свой профиль без имени тоже не «Контакт»', () => {
    const id = peekIdentity({ contact: null, did: DID, isSelf: true });
    expect(id.title).toBe('Без имени');
    expect(id.contactName).toBe(shortDid(DID, 6));
  });
});
