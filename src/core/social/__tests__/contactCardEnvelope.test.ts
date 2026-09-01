/**
 * Карточка контакта от чужого клиента.
 *
 * До v4.32.239 разбор был одним JSON.parse с приведением типа, а оба экрана
 * сразу делали card.pub.slice(...). Мусор в карточке ронял не пузырь, а весь
 * экран переписки — и удалить сообщение было нельзя, потому что для этого
 * нужно открыть тот самый чат.
 */

import { CONTACT_CARD_PREFIX, isContactCard, makeContactCardText, parseContactCard } from '../contactCardEnvelope';

/** Настоящий base64 32-байтного ключа. */
const PUB = 'A'.repeat(43);

describe('parseContactCard', () => {
  it('round-trip: имя и ключ доезжают как есть', () => {
    expect(parseContactCard(makeContactCardText('Аня', PUB))).toEqual({ name: 'Аня', pub: PUB });
    expect(isContactCard(makeContactCardText('Аня', PUB))).toBe(true);
  });

  it('не карточка — null, а не исключение', () => {
    for (const t of ['', 'привет', '\x01voice:cid', CONTACT_CARD_PREFIX]) {
      expect(parseContactCard(t)).toBeNull();
    }
  });

  it('мусор вместо объекта не доходит до render', () => {
    // Каждый из этих случаев раньше давал TypeError на card.pub.slice(0, 12).
    for (const body of ['123', '"строка"', 'null', 'true', '[1,2]', '{}', '{"name":"Аня"}', 'не json']) {
      expect(parseContactCard(CONTACT_CARD_PREFIX + body)).toBeNull();
    }
  });

  it('ключ обязан быть настоящим Ed25519-ключом', () => {
    // Карточка предлагает сохранить чужой ключ в контакты: строка, которая не
    // разбирается в 32 байта, там оставит битый контакт и падение на первой же
    // криптооперации.
    for (const pub of ['', 'короткий', 'A'.repeat(64), `${'A'.repeat(42)}!`, 'A'.repeat(43) + 'ZZ']) {
      expect(parseContactCard(CONTACT_CARD_PREFIX + JSON.stringify({ name: 'Аня', pub }))).toBeNull();
    }
    // С паддингом — валидный вариант того же ключа.
    expect(parseContactCard(CONTACT_CARD_PREFIX + JSON.stringify({ name: 'Аня', pub: `${'A'.repeat(43)}=` }))).not.toBeNull();
  });

  it('имя вычищается: оно уходит в контакты, заголовки и пересылки', () => {
    const card = parseContactCard(CONTACT_CARD_PREFIX + JSON.stringify({ name: 'Аня\nВы заблокированы', pub: PUB }));
    expect(card?.name).toBe('Аня Вы заблокированы');
    expect(card?.name).not.toContain('\n');
  });

  it('нестроковое имя не роняет карточку — ключ всё равно годный', () => {
    const card = parseContactCard(CONTACT_CARD_PREFIX + JSON.stringify({ name: 42, pub: PUB }));
    expect(card).toEqual({ name: '', pub: PUB });
  });

  it('карточка длиннее килобайта отбрасывается', () => {
    expect(parseContactCard(CONTACT_CARD_PREFIX + JSON.stringify({ name: 'и'.repeat(5000), pub: PUB }))).toBeNull();
  });
});
