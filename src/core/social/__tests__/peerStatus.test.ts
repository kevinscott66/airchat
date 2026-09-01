/**
 * Статус собеседника: чужая строка под его именем (v4.32.375).
 */
import { MAX_CUSTOM_STATUS_LEN, normalizeOwnStatus, presenceSubtitle, sanitizePeerStatus } from '../peerStatus';

describe('sanitizePeerStatus', () => {
  it('обычный статус не меняется', () => {
    for (const s of ['на созвоне', '\u{1F334} в отпуске до среды', 'busy']) {
      expect(sanitizePeerStatus(s)).toBe(s);
    }
  });

  it('метки направления письма вырезаются', () => {
    // Подзаголовок шапки — то место, где приложение говорит своим голосом:
    // «в сети», «печатает», «Исчезают через 5 минут».
    expect(sanitizePeerStatus('на\u202E созвоне')).toBe('на созвоне');
    expect(sanitizePeerStatus('a\u200Bб\uFEFF')).toBe('aб');
  });

  it('перевод строки становится пробелом, а не второй строкой', () => {
    // Место в шапке рассчитано на одну строку.
    expect(sanitizePeerStatus('занят\nдо вечера')).toBe('занят до вечера');
    expect(sanitizePeerStatus('занят\u2028до вечера')).toBe('занят до вечера');
    expect(sanitizePeerStatus('a\x00b\x1fc')).toBe('a b c');
  });

  it('статус из одних невидимых символов — это отсутствие статуса', () => {
    // Иначе он проходит проверку на истинность и молча перекрывает строку
    // присутствия: «был(а) недавно» пропадает, а причины на экране нет.
    for (const s of ['', '   ', '\u200D', '\u2800\u2800', '\n\n', '\u3164']) {
      expect([JSON.stringify(s), sanitizePeerStatus(s)]).toEqual([JSON.stringify(s), null]);
    }
  });

  it('не строка — тоже отсутствие статуса', () => {
    for (const v of [null, undefined, 42, {}, ['на созвоне']]) {
      expect(sanitizePeerStatus(v)).toBeNull();
    }
  });

  it('длина ограничивается общим пределом, края не остаются пустыми', () => {
    expect(sanitizePeerStatus('я'.repeat(200))).toHaveLength(MAX_CUSTOM_STATUS_LEN);
    expect(MAX_CUSTOM_STATUS_LEN).toBe(60);
    // Обрезка попала на пробел — хвоста от него не остаётся.
    expect(sanitizePeerStatus('  на созвоне  ')).toBe('на созвоне');
  });
});

describe('normalizeOwnStatus — свой статус перед записью в базу', () => {
  it('то же правило, что и на приёме, только пустая строка вместо null', () => {
    expect(normalizeOwnStatus('на созвоне')).toBe('на созвоне');
    expect(normalizeOwnStatus('  на созвоне  ')).toBe('на созвоне');
    expect(normalizeOwnStatus('\u200D')).toBe('');
    expect(normalizeOwnStatus(null)).toBe('');
    expect(normalizeOwnStatus(undefined)).toBe('');
  });

  it('многострочный статус из прежнего редактора в настройках сводится к строке', () => {
    // До v4.32.375 редактор в настройках был multiline и на 100 символов, а
    // тот же статус в профиле — однострочный и на 60. В базе от этого лежат
    // строки, которых ни один из редакторов сегодня набрать не даст.
    expect(normalizeOwnStatus('в отпуске\nдо среды')).toBe('в отпуске до среды');
    expect(normalizeOwnStatus('я'.repeat(100))).toHaveLength(MAX_CUSTOM_STATUS_LEN);
  });
});

describe('presenceSubtitle — подзаголовок в шапке переписки', () => {
  it('присутствие и статус помещаются оба, присутствие впереди', () => {
    // Порядок решает, чему достанется место при обрезке по краю: обрезается
    // хвост статуса, а не «в сети».
    expect(presenceSubtitle('в сети', 'на созвоне')).toBe('в сети · на созвоне');
  });

  it('статус больше не отбирает у шапки строку присутствия', () => {
    // До v4.32.375 ветка со статусом стояла первой: собеседник, однажды
    // написавший «на созвоне», навсегда забирал строку «был(а) недавно».
    expect(presenceSubtitle('был(а) недавно', 'на созвоне')).toContain('был(а) недавно');
  });

  it('когда есть только одно — только оно, без разделителя', () => {
    expect(presenceSubtitle('в сети', null)).toBe('в сети');
    expect(presenceSubtitle('', 'на созвоне')).toBe('на созвоне');
    expect(presenceSubtitle(null, undefined)).toBe('');
    expect(presenceSubtitle('', '')).toBe('');
  });
});
