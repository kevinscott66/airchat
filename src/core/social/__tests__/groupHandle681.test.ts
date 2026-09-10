/**
 * v4.32.681: публичный адрес группы и канала — «@имя».
 *
 * Проверяется ровно то, ради чего модуль и написан: правила имени НЕ пишутся
 * для групп заново, а берутся у общей заявки на юзернейм (checkUsernameClaim).
 * Иначе канал мог бы назваться @support или @official — то есть перехватывать
 * доверие, которое человек оказывает системным адресам.
 */
import { checkGroupHandle, normalizeGroupHandle, formatGroupHandle } from '../groupHandle';
import { RESERVED_USERNAMES, USERNAME_MIN_SELF_SERVICE } from '../../identity/reservedUsernames';

describe('публичный адрес группы: правила общие с аккаунтами', () => {
  it('обычный адрес принимается и приводится к канону', () => {
    const r = checkGroupHandle('  @AirCafe ', 'group');
    expect(r).toEqual({ ok: true, handle: 'aircafe' });
  });

  it('занятые системой слова группе не достаются', () => {
    // ПРОВЕРКА НЕ ПУСТАЯ: перечень непустой и содержит те самые слова.
    expect(RESERVED_USERNAMES.size).toBeGreaterThan(10);
    for (const word of ['support', 'official', 'airchat', 'admin']) {
      expect(RESERVED_USERNAMES.has(word)).toBe(true);
      const r = checkGroupHandle(word, 'channel');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('reserved');
    }
  });

  it('адрес из одних цифр отвергается', () => {
    const r = checkGroupHandle('123456', 'group');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('digits_only');
  });

  it('короткий адрес отвергается по общему порогу самообслуживания', () => {
    const short = 'a'.repeat(USERNAME_MIN_SELF_SERVICE - 1);
    const r = checkGroupHandle(short, 'group');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_short');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: ровно на пороге адрес уже проходит.
    expect(checkGroupHandle('a'.repeat(USERNAME_MIN_SELF_SERVICE), 'group').ok).toBe(true);
  });

  it('слишком длинный адрес отвергается', () => {
    const r = checkGroupHandle('a'.repeat(33), 'group');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
    // ПОВОД ДЛЯ ПРАВКИ ЖИВ: ровно на пределе адрес проходит.
    expect(checkGroupHandle('a'.repeat(32), 'group').ok).toBe(true);
  });

  it('чужой набор символов отвергается', () => {
    for (const bad of ['кафе12', 'air-cafe', 'air cafe', 'air.cafe']) {
      const r = checkGroupHandle(bad, 'group');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('charset');
    }
  });

  it('текст отказа зависит от вида и не называет чужого адреса', () => {
    const g = checkGroupHandle('', 'group');
    const c = checkGroupHandle('', 'channel');
    expect(g.ok).toBe(false);
    expect(c.ok).toBe(false);
    if (!g.ok && !c.ok) {
      expect(g.text).toContain('группы');
      expect(c.text).toContain('канала');
      // Пункт 5 пожеланий: причина «занято» не объясняется подробностями.
      expect(checkGroupHandle('support', 'group')).toMatchObject({ text: 'Этот адрес занят.' });
    }
  });

  it('не строка — не адрес', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(checkGroupHandle(bad, 'group').ok).toBe(false);
      expect(normalizeGroupHandle(bad)).toBeNull();
    }
  });

  it('собачка приклеивается ровно в одном месте', () => {
    expect(formatGroupHandle('aircafe')).toBe('@aircafe');
  });

  it('протокольная нормализация мягче ввода администратора', () => {
    // Конверт с чужого устройства мог быть собран версией, где порог был
    // другим; отбрасывать из-за этого весь конверт нельзя.
    const shortName = 'a'.repeat(USERNAME_MIN_SELF_SERVICE - 1);
    expect(checkGroupHandle(shortName, 'group').ok).toBe(false);
    expect(normalizeGroupHandle(shortName)).toBe(shortName);
    // …но мусор не проходит и здесь.
    expect(normalizeGroupHandle('air cafe')).toBeNull();
  });
});
