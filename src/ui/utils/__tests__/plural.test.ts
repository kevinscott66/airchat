/**
 * Русская плюрализация: модуль без импортов, поэтому проверяется напрямую.
 *
 * Правило трёх форм ошибаются чаще всего на 11–14 (там форма как у «пять»,
 * хотя последняя цифра 1–4) и на 111/112 — их и проверяем отдельно.
 */
import { membersLabel, ruPlural, subscribersLabel, votesLabel } from '../plural';

const FORMS: [string, string, string] = ['голос', 'голоса', 'голосов'];

describe('ruPlural', () => {
  it('единственное число — 1, 21, 101', () => {
    expect(ruPlural(1, FORMS)).toBe('голос');
    expect(ruPlural(21, FORMS)).toBe('голос');
    expect(ruPlural(101, FORMS)).toBe('голос');
  });

  it('форма 2–4 — 2, 3, 4, 22, 104', () => {
    expect(ruPlural(2, FORMS)).toBe('голоса');
    expect(ruPlural(3, FORMS)).toBe('голоса');
    expect(ruPlural(4, FORMS)).toBe('голоса');
    expect(ruPlural(22, FORMS)).toBe('голоса');
    expect(ruPlural(104, FORMS)).toBe('голоса');
  });

  it('форма 5+ — 0, 5, 20, 100', () => {
    expect(ruPlural(0, FORMS)).toBe('голосов');
    expect(ruPlural(5, FORMS)).toBe('голосов');
    expect(ruPlural(20, FORMS)).toBe('голосов');
    expect(ruPlural(100, FORMS)).toBe('голосов');
  });

  it('исключение 11–14 берёт форму 5+, а не 2–4', () => {
    expect(ruPlural(11, FORMS)).toBe('голосов');
    expect(ruPlural(12, FORMS)).toBe('голосов');
    expect(ruPlural(13, FORMS)).toBe('голосов');
    expect(ruPlural(14, FORMS)).toBe('голосов');
    expect(ruPlural(112, FORMS)).toBe('голосов');
  });

  it('отрицательные считаются по модулю', () => {
    expect(ruPlural(-1, FORMS)).toBe('голос');
    expect(ruPlural(-3, FORMS)).toBe('голоса');
    expect(ruPlural(-11, FORMS)).toBe('голосов');
  });
});

describe('готовые подписи', () => {
  it('votesLabel', () => {
    expect(votesLabel(1)).toBe('1 голос');
    expect(votesLabel(2)).toBe('2 голоса');
    expect(votesLabel(5)).toBe('5 голосов');
    expect(votesLabel(11)).toBe('11 голосов');
  });

  it('membersLabel и subscribersLabel', () => {
    expect(membersLabel(1)).toBe('1 участник');
    expect(membersLabel(3)).toBe('3 участника');
    expect(membersLabel(0)).toBe('0 участников');
    expect(subscribersLabel(1)).toBe('1 подписчик');
    expect(subscribersLabel(22)).toBe('22 подписчика');
  });
});
