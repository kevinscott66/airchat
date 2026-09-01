/**
 * Кто видит время последнего входа.
 *
 * Настройка была почти декоративной: «Контакты» не отличалось от «Все», а
 * единственная проверка стояла в коде, который на телефонах не выполняется.
 * Обе половины исправления закреплены здесь.
 */

import {
  parseLastSeenVisibility,
  shouldShareLastSeenWith,
  canSeePeerLastSeen,
} from '../presencePolicy';

describe('parseLastSeenVisibility', () => {
  it('известные значения', () => {
    expect(parseLastSeenVisibility('everybody')).toBe('everybody');
    expect(parseLastSeenVisibility('contacts')).toBe('contacts');
    expect(parseLastSeenVisibility('nobody')).toBe('nobody');
  });

  it('пусто и мусор — «Все» (поведение до появления настройки)', () => {
    expect(parseLastSeenVisibility(null)).toBe('everybody');
    expect(parseLastSeenVisibility(undefined)).toBe('everybody');
    expect(parseLastSeenVisibility('')).toBe('everybody');
    expect(parseLastSeenVisibility('NOBODY')).toBe('everybody');
    expect(parseLastSeenVisibility('друзья')).toBe('everybody');
  });
});

describe('shouldShareLastSeenWith', () => {
  it('«Все» — показывать любому', () => {
    expect(shouldShareLastSeenWith({ visibility: 'everybody', isContact: true })).toBe(true);
    expect(shouldShareLastSeenWith({ visibility: 'everybody', isContact: false })).toBe(true);
  });

  it('«Никто» — не показывать никому, включая контакты', () => {
    expect(shouldShareLastSeenWith({ visibility: 'nobody', isContact: true })).toBe(false);
    expect(shouldShareLastSeenWith({ visibility: 'nobody', isContact: false })).toBe(false);
  });

  it('«Контакты» наконец отличается от «Все»', () => {
    // Ровно то, чего не было: раньше оба варианта вели себя одинаково.
    expect(shouldShareLastSeenWith({ visibility: 'contacts', isContact: true })).toBe(true);
    expect(shouldShareLastSeenWith({ visibility: 'contacts', isContact: false })).toBe(false);
  });
});

describe('canSeePeerLastSeen', () => {
  it('просьба собеседника исполняется при любой своей настройке', () => {
    for (const myVisibility of ['everybody', 'contacts'] as const) {
      expect(canSeePeerLastSeen({ peerAllows: false, myVisibility })).toBe(false);
    }
  });

  it('без просьбы показываем — так было всегда', () => {
    expect(canSeePeerLastSeen({ peerAllows: undefined, myVisibility: 'everybody' })).toBe(true);
    expect(canSeePeerLastSeen({ peerAllows: true, myVisibility: 'everybody' })).toBe(true);
    expect(canSeePeerLastSeen({ peerAllows: undefined, myVisibility: 'contacts' })).toBe(true);
  });

  it('взаимность: спрятал своё время — не видишь чужого', () => {
    // Эта половина работает независимо от чужого клиента, поэтому именно она
    // делает выбор «Никто» осмысленным.
    expect(canSeePeerLastSeen({ peerAllows: undefined, myVisibility: 'nobody' })).toBe(false);
    expect(canSeePeerLastSeen({ peerAllows: true, myVisibility: 'nobody' })).toBe(false);
  });
});
