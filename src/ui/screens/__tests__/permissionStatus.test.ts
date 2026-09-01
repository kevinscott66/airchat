import {
  mapAndroidPermission,
  mapExpoPermission,
  permissionTapAction,
} from '../permissionStatus';

describe('mapExpoPermission', () => {
  it('выданное разрешение', () => {
    expect(mapExpoPermission({ status: 'granted', canAskAgain: true })).toBe('granted');
  });

  it('отказ, который можно переспросить — не тупик', () => {
    // Ровно этот случай раньше считался «заблокировано»: одно случайное
    // «Запретить» отправляло человека в настройки системы навсегда.
    expect(mapExpoPermission({ status: 'denied', canAskAgain: true })).toBe('denied');
  });

  it('отказ без права переспрашивать — только настройки', () => {
    expect(mapExpoPermission({ status: 'denied', canAskAgain: false })).toBe('blocked');
  });

  it('не спрашивали — состояние неизвестно', () => {
    expect(mapExpoPermission({ status: 'undetermined' })).toBe('unknown');
  });

  it('без canAskAgain считаем, что переспросить можно', () => {
    expect(mapExpoPermission({ status: 'denied' })).toBe('denied');
  });

  it('пустой и мусорный ответ не роняют экран', () => {
    expect(mapExpoPermission(null)).toBe('unknown');
    expect(mapExpoPermission(undefined)).toBe('unknown');
    expect(mapExpoPermission({ status: 'что-то новое' })).toBe('denied');
    expect(mapExpoPermission({} as { status: string })).toBe('unknown');
  });
});

describe('mapAndroidPermission', () => {
  it('выданное разрешение', () => {
    expect(mapAndroidPermission('granted')).toBe('granted');
  });

  it('обычный отказ', () => {
    expect(mapAndroidPermission('denied')).toBe('denied');
  });

  it('«больше не спрашивать» — только настройки', () => {
    // Раньше сваливалось в обычный отказ: повторное нажатие вызывало запрос,
    // который система гасит молча, и карточка не менялась вообще.
    expect(mapAndroidPermission('never_ask_again')).toBe('blocked');
  });

  it('пустой и мусорный ответ не роняют экран', () => {
    expect(mapAndroidPermission(null)).toBe('unknown');
    expect(mapAndroidPermission(undefined)).toBe('unknown');
    expect(mapAndroidPermission('')).toBe('unknown');
  });
});

describe('permissionTapAction', () => {
  it('выданное трогать незачем', () => {
    expect(permissionTapAction('granted')).toBe('none');
  });

  it('неизвестное и отказанное — спрашиваем', () => {
    expect(permissionTapAction('unknown')).toBe('request');
    expect(permissionTapAction('denied')).toBe('request');
  });

  it('заблокированное — настройки системы', () => {
    expect(permissionTapAction('blocked')).toBe('open_settings');
  });
});
