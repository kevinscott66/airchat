/**
 * Подписи настроек. Раньше эти функции лежали внутри экрана и не проверялись
 * ничем: чтобы до них добраться, тест поднимал бы весь SettingsScreen.
 *
 * Проверяется в первую очередь запасной путь. Intl.DisplayNames собран не в
 * каждой сборке Hermes, и когда его нет, в списке активных сессий вместо
 * страны оставался бы голый код — «AE» вместо «ОАЭ». Тест не может убрать
 * Intl из этой среды, поэтому смотрит на то, что видно всегда: код страны
 * никогда не показывается как есть, если название известно.
 */
import {
  autoDeleteLabel,
  countryName,
  sessionDeviceName,
  sessionLocation,
} from '../settings/settingsLabels';
import type { SyncDevice } from '../../../core/sync/syncApi';

const device = (p: Partial<SyncDevice>): SyncDevice => ({ id: 'd1', ...p }) as SyncDevice;

describe('countryName', () => {
  it('знает страны из запасного списка', () => {
    expect(countryName('RU')).toBe('Россия');
  });

  it('страну вне запасного списка называет словом, а не кодом', () => {
    // Здесь Intl есть, поэтому ответ приходит от него; важно, что это не 'NL'.
    expect(countryName('NL')).not.toBe('NL');
  });

  it('неизвестный код отдаёт как есть, а не теряет', () => {
    expect(countryName('XX')).toBe('XX');
  });
});

describe('sessionLocation', () => {
  it('город и страна вместе', () => {
    expect(sessionLocation(device({ city: 'Москва', countryCode: 'RU' }))).toBe('Москва, Россия');
  });

  it('без города остаётся страна', () => {
    expect(sessionLocation(device({ countryCode: 'RU' }))).toBe('Россия');
  });

  it('пустое место не выдаётся за известное', () => {
    expect(sessionLocation(device({}))).toBe('Регион не определён');
  });
});

describe('sessionDeviceName', () => {
  it('модель точнее подписи и идёт первой', () => {
    expect(sessionDeviceName(device({ deviceModel: 'iPhone 16 Plus', label: 'рабочий' })))
      .toBe('iPhone 16 Plus');
  });

  it('без модели остаётся подпись', () => {
    expect(sessionDeviceName(device({ label: 'рабочий' }))).toBe('рабочий');
  });

  it('пусто — говорит, что не знает, а не показывает пустую строку', () => {
    expect(sessionDeviceName(device({}))).toBe('Неизвестное устройство');
  });
});

describe('autoDeleteLabel', () => {
  it('ноль и null — это «Выкл», а не «0 мин»', () => {
    expect(autoDeleteLabel(null)).toBe('Выкл');
    expect(autoDeleteLabel(0)).toBe('Выкл');
  });

  it('округляет вниз до знакомого срока', () => {
    expect(autoDeleteLabel(86_400_000 * 25)).toBe('7 дней');
    expect(autoDeleteLabel(86_400_000)).toBe('1 день');
    expect(autoDeleteLabel(86_400_000 - 1)).toBe('1 час');
    expect(autoDeleteLabel(3_600_000)).toBe('1 час');
    expect(autoDeleteLabel(60_000)).toBe('1 мин');
  });
});
