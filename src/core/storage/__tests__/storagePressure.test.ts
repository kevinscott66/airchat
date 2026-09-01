/**
 * «На устройстве кончилось место» (v4.32.300).
 *
 * Проверять это на живой базе нечем: нужен телефон с забитым диском. А цена
 * ошибки высокая в обе стороны — не сказать вовсе значит терять сообщения
 * молча, сказать не к месту значит пугать человека посреди переписки.
 */
import {
  NO_PRESSURE,
  PRESSURE_SNOOZE_MS,
  classifyStorageError,
  onPressureDismiss,
  onPressureEvent,
} from '../storagePressure';

describe('classifyStorageError', () => {
  it('переполнение опознаётся во всех виденных формах', () => {
    for (const msg of [
      'SQLITE_FULL: database or disk is full',
      'Error: database or disk is full (13)',
      'write failed: no space left on device',
      'ENOSPC: no space left on device, write',
    ]) {
      expect(classifyStorageError(new Error(msg))).toBe('disk_full');
    }
  });

  it('ошибка ввода-вывода — отдельный, более мягкий случай', () => {
    expect(classifyStorageError(new Error('SQLITE_IOERR_WRITE'))).toBe('io_error');
    expect(classifyStorageError(new Error('disk I/O error'))).toBe('io_error');
  });

  it('обычная ошибка базы местом не считается', () => {
    // Иначе предупреждение «освободите место» вылезало бы на конфликте ключей
    // или на закрытой базе — и человек чистил бы телефон впустую.
    for (const msg of [
      'UNIQUE constraint failed: chat_messages.id',
      'database is locked',
      'no such table: groups',
      'attempt to write a readonly database',
    ]) {
      expect(classifyStorageError(new Error(msg))).toBeNull();
    }
  });

  it('не-ошибка тоже разбирается: в catch прилетает что угодно', () => {
    expect(classifyStorageError('SQLITE_FULL')).toBe('disk_full');
    expect(classifyStorageError(null)).toBeNull();
    expect(classifyStorageError(undefined)).toBeNull();
    expect(classifyStorageError({ code: 13 })).toBeNull();
  });
});

describe('показ предупреждения', () => {
  const T0 = 1_700_000_000_000;

  it('первое событие показывает предупреждение', () => {
    expect(onPressureEvent(NO_PRESSURE, 'disk_full', T0)).toEqual({
      shown: 'disk_full',
      dismissedAt: null,
    });
  });

  it('поток одинаковых событий ничего не меняет', () => {
    // На полном диске падает каждая запись, а пишет приложение постоянно.
    let s = onPressureEvent(NO_PRESSURE, 'disk_full', T0);
    for (let i = 1; i <= 50; i++) s = onPressureEvent(s, 'disk_full', T0 + i);
    expect(s).toEqual({ shown: 'disk_full', dismissedAt: null });
  });

  it('«место кончилось» важнее ошибки ввода-вывода и не затирается ею', () => {
    const s = onPressureEvent(NO_PRESSURE, 'disk_full', T0);
    expect(onPressureEvent(s, 'io_error', T0 + 5).shown).toBe('disk_full');
  });

  it('а само оно ошибку ввода-вывода вытесняет', () => {
    const s = onPressureEvent(NO_PRESSURE, 'io_error', T0);
    expect(onPressureEvent(s, 'disk_full', T0 + 5).shown).toBe('disk_full');
  });

  it('закрытое рукой молчит и не возвращается следующей же записью', () => {
    const shown = onPressureEvent(NO_PRESSURE, 'disk_full', T0);
    const closed = onPressureDismiss(shown, T0 + 1_000);
    expect(closed.shown).toBeNull();
    const again = onPressureEvent(closed, 'disk_full', T0 + 1_100);
    expect(again.shown).toBeNull();
    expect(again).toBe(closed);
  });

  it('но возвращается, если место так и не освободили', () => {
    const closed = onPressureDismiss(onPressureEvent(NO_PRESSURE, 'disk_full', T0), T0);
    const later = onPressureEvent(closed, 'disk_full', T0 + PRESSURE_SNOOZE_MS + 1);
    expect(later).toEqual({ shown: 'disk_full', dismissedAt: null });
  });

  it('после возврата закрыть можно снова', () => {
    let s = onPressureDismiss(onPressureEvent(NO_PRESSURE, 'disk_full', T0), T0);
    s = onPressureEvent(s, 'disk_full', T0 + PRESSURE_SNOOZE_MS + 1);
    s = onPressureDismiss(s, T0 + PRESSURE_SNOOZE_MS + 2);
    expect(s.shown).toBeNull();
    expect(onPressureEvent(s, 'disk_full', T0 + PRESSURE_SNOOZE_MS + 3).shown).toBeNull();
  });
});
