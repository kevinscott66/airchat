/**
 * Разбор отказа браузерного хранилища. Цена ошибки здесь — человек, которому
 * сказали чинить не то: смену браузера при сломанном сертификате или наоборот.
 */
import {
  currentStorageEnv,
  diagnoseStorageFailure,
  isStorageFailure,
} from '../webStorageDiagnosis';

const REAL = 'navigator.storage not available (not supported by your browser or context is not secure)';

describe('что это за ошибка', () => {
  it('узнаёт настоящий текст с air.dobropalm.tech', () => {
    expect(isStorageFailure(REAL)).toBe(true);
  });

  it('узнаёт другие формулировки того же отказа', () => {
    for (const m of [
      'SecurityError: Failed to execute getDirectory',
      'OPFS is not available',
      'context is not secure',
    ]) {
      expect(isStorageFailure(m)).toBe(true);
    }
  });

  it('не трогает посторонние ошибки запуска', () => {
    for (const m of ['profileManager.init timed out', 'Network request failed', '']) {
      expect(isStorageFailure(m)).toBe(false);
      expect(diagnoseStorageFailure(m, { secureContext: false, hasOpfs: false, origin: null })).toBeNull();
    }
  });
});

describe('диагноз', () => {
  it('незащищённое соединение — это про сертификат, а не про браузер', () => {
    const text = diagnoseStorageFailure(REAL, {
      secureContext: false,
      hasOpfs: false,
      origin: 'http://air.dobropalm.tech',
    });
    expect(text).toContain('незащищённому соединению');
    expect(text).toContain('air.dobropalm.tech');
    expect(text).toContain('сертификате сайта');
    // Совет сменить браузер здесь был бы ложным следом.
    expect(text).not.toContain('Safari 17');
  });

  it('защищённое соединение без OPFS — это про браузер', () => {
    const text = diagnoseStorageFailure(REAL, {
      secureContext: true,
      hasOpfs: false,
      origin: 'https://air.dobropalm.tech',
    });
    expect(text).toContain('Safari 17');
    expect(text).toContain('приватных окнах');
    expect(text).not.toContain('незащищённому соединению');
  });

  it('всё на месте, а база не открылась — не выдумывает причину', () => {
    const text = diagnoseStorageFailure(REAL, {
      secureContext: true,
      hasOpfs: true,
      origin: 'https://air.dobropalm.tech',
    });
    expect(text).toContain('не дал приложению открыть базу');
    expect(text).not.toContain('Safari 17');
    expect(text).not.toContain('незащищённому соединению');
  });

  it('неизвестный контекст не выдаётся за незащищённый', () => {
    // На устройстве isSecureContext нет вовсе; сказать «у вас HTTP» было бы враньём.
    const text = diagnoseStorageFailure(REAL, { secureContext: null, hasOpfs: false, origin: null });
    expect(text).toContain('Safari 17');
  });
});

describe('чтение окружения', () => {
  it('на устройстве отдаёт пустые факты и ничего не роняет', () => {
    const env = currentStorageEnv();
    expect(env.hasOpfs).toBe(false);
    expect(env.secureContext === null || typeof env.secureContext === 'boolean').toBe(true);
  });
});
