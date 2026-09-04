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

describe('файл базы занят другой вкладкой', () => {
  // Ровно то, что показывают браузеры: Chrome называет причину, WebKit — нет.
  const CHROME =
    "NoModificationAllowedError: Failed to execute 'createSyncAccessHandle' on " +
    "'FileSystemFileHandle': Access Handles cannot be created if there is another " +
    'open Access Handle or Writable stream associated with the same file.';
  const WEBKIT =
    'UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).';

  // Окружение исправно — по фактам этот отказ неотличим от «нет места на диске».
  const OK_ENV = { secureContext: true, hasOpfs: true, origin: 'https://air.dobropalm.tech' };

  it('узнаёт обе формулировки', () => {
    expect(isStorageFailure(CHROME)).toBe(true);
    expect(isStorageFailure(WEBKIT)).toBe(true);
  });

  it('Chrome назвал причину — говорим её прямо', () => {
    const text = diagnoseStorageFailure(CHROME, OK_ENV);
    expect(text).toContain('занят вкладкой со старой версией');
    expect(text).toContain('вкладки с AirChat');
    // Совет из ветки «всё на месте» был бы неверным следом: диск ни при чём.
    expect(text).not.toContain('переполненный');
  });

  it('WebKit причину не назвал — оговариваемся, но советуем то же', () => {
    const text = diagnoseStorageFailure(WEBKIT, OK_ENV);
    expect(text).toContain('не назвал причину');
    expect(text).toContain('вкладки с AirChat');
    expect(text).not.toContain('переполненный');
  });

  it('обещает, что переписка на месте — иначе человек начнёт чистить данные сайта', () => {
    for (const m of [CHROME, WEBKIT]) {
      expect(diagnoseStorageFailure(m, OK_ENV)).toContain('никуда не денутся');
    }
  });

  it('занятый файл разбирается раньше сертификата и браузера', () => {
    // Те же факты, что в ветке «нет OPFS», но причина известна точнее.
    const text = diagnoseStorageFailure(CHROME, {
      secureContext: false,
      hasOpfs: false,
      origin: null,
    });
    expect(text).toContain('занят вкладкой со старой версией');
    expect(text).not.toContain('Safari 17');
    expect(text).not.toContain('незащищённому соединению');
  });
});

describe('чтение окружения', () => {
  it('на устройстве отдаёт пустые факты и ничего не роняет', () => {
    const env = currentStorageEnv();
    expect(env.hasOpfs).toBe(false);
    expect(env.secureContext === null || typeof env.secureContext === 'boolean').toBe(true);
  });
});
