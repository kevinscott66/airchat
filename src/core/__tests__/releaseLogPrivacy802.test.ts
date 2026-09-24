/**
 * Боевая сборка больше не кладёт личность человека в системный журнал
 * (v4.32.802).
 *
 * Дефект. В `MainScreen` стоял костыль для ручного прогона с двух устройств:
 * на каждом монтировании экрана DID и публичный ключ уходили в `log.info`, а
 * DID ещё и в файл `adb_test_identity_did.txt` в кэше. Имя сообщения было
 * внесено в список тех, что `logger.ts` выпускает в консоль релиза, — и вместе
 * с ним по префиксам `dm_`, `internet_`, `chat_` наружу шли `meta` десятков
 * других сообщений: полный идентификатор сообщения, кусок DID собеседника.
 *
 * Цена. Постоянный идентификатор человека ложился в os_log/logcat при каждом
 * запуске, а файл в кэше не подходил ни под один префикс в `cacheFiles.ts` —
 * его не стирали ни «Очистить кэш», ни полный сброс. То есть он переживал то,
 * что задумано как «после меня ничего не осталось». Рядом — журнал, по
 * которому видно, с кем и когда шла переписка, при том что сами сообщения
 * лежат зашифрованными.
 *
 * Правка. Костыль удалён вместе с файлом. `meta` на пути в консоль релиза
 * проходит через `scrubTelemetryContext` — ту же функцию, что готовит отчёты
 * об ошибках: скрывается DID, длинный base64, длинный hex и поле, в имени
 * которого есть «key»/«did»/«pub». Числа и коды ошибок остаются: ради них
 * журнал и читают.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../logger';
import { SCRUBBED } from '../errorScrub';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

type Globals = {
  __DEV__?: boolean;
  __airchatOrigConsoleLog?: ((s: string) => void) | undefined;
};
const g = globalThis as unknown as Globals;

/** Что ушло в системный журнал устройства за время вызова. */
let emitted: string[] = [];

/**
 * Прогнать запись так, как она пойдёт в боевой сборке.
 *
 * Тишина по умолчанию и список исключений живут в ветке `!__DEV__ && !fileSink`
 * — без подмены `__DEV__` проверялась бы отладочная сборка, где в журнал
 * уходит всё и всегда.
 */
function inRelease(fn: () => void): string[] {
  const devWas = g.__DEV__;
  const emitWas = g.__airchatOrigConsoleLog;
  emitted = [];
  g.__DEV__ = false;
  g.__airchatOrigConsoleLog = (s: string) => {
    emitted.push(s);
  };
  try {
    fn();
  } finally {
    g.__DEV__ = devWas;
    g.__airchatOrigConsoleLog = emitWas;
  }
  return emitted;
}

/** Разобрать единственную строку журнала. */
function onlyLine(lines: string[]): { msg: string; meta?: Record<string, unknown> } {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as { msg: string; meta?: Record<string, unknown> };
}

const SOME_DID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const SOME_MSG_ID = '3f6c0a1e-8b7d-4c21-9a55-0e2b7c4d9f10';

describe('журнал боевой сборки не связывает себя с человеком', () => {
  it('идентификатор сообщения не уходит в системный журнал', () => {
    const line = onlyLine(inRelease(() => log.info('dm_incoming_saved', { messageId: SOME_MSG_ID })));
    expect(line.meta?.messageId).toBe(SCRUBBED);
    expect(JSON.stringify(line)).not.toContain(SOME_MSG_ID);
  });

  it('DID собеседника не уходит в системный журнал', () => {
    const line = onlyLine(inRelease(() => log.info('internet_send_ok', { targetDid: SOME_DID })));
    expect(line.meta?.targetDid).toBe(SCRUBBED);
    expect(JSON.stringify(line)).not.toContain('z6Mkha');
  });

  it('и кусок DID тоже: скрывается поле, а не только полное совпадение', () => {
    const line = onlyLine(inRelease(() => log.info('internet_send_ok', { targetDid: SOME_DID.slice(0, 24) })));
    expect(line.meta?.targetDid).toBe(SCRUBBED);
  });

  it('сообщения автотеста больше нет — ни в списке, ни в журнале', () => {
    expect(inRelease(() => log.info('auto_test_identity', { did: SOME_DID }))).toEqual([]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: журнал остался читаемым', () => {
  it('числа, коды и слова проходят как были', () => {
    const line = onlyLine(inRelease(() => log.warn('internet_send_failed', { status: 404, ms: 1200, kind: 'AbortError' })));
    expect(line.meta).toEqual({ status: 404, ms: 1200, kind: 'AbortError' });
  });

  it('имя сообщения не трогается', () => {
    const line = onlyLine(inRelease(() => log.info('transport_success', { ms: 12 })));
    expect(line.msg).toBe('transport_success');
  });

  it('чужие сообщения в релизе по-прежнему молчат', () => {
    expect(inRelease(() => log.info('ничего_особенного', { a: 1 }))).toEqual([]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('список пропускает целыми семействами — решение принимает не автор поля', () => {
    const body = codeOnly(read('core/logger.ts'));
    // Заводя новое `dm_…` сообщение, автор не выбирает, показывать ли его meta
    // в системном журнале: выбор сделан один раз, этими строками.
    expect(body).toContain("if (msg.startsWith('dm_')) return true;");
    expect(body).toContain("if (msg.startsWith('internet_')) return true;");
  });

  it('уборка кэша работает по списку префиксов — чужого файла она не знает', () => {
    const body = codeOnly(read('core/media/cacheFiles.ts'));
    expect(body).toContain('CLEARABLE_CACHE_PREFIXES');
    expect(body).toContain('WIPE_CACHE_PREFIXES');
    expect(body).not.toContain('adb_');
  });
});

describe('форма исходников: правка стоит там, где сказано', () => {
  it('костыля автотеста в приложении нет', () => {
    const body = codeOnly(read('App.tsx'));
    expect(body).not.toContain('auto_test_identity');
    expect(body).not.toContain('adb_test_identity');
  });

  it('meta на пути в консоль релиза проходит очистку', () => {
    const body = codeOnly(read('core/logger.ts'));
    expect(body).toContain("import { scrubTelemetryContext } from './errorScrub';");
    expect(body).toContain('emit(serialize(level, msg, scrubTelemetryContext(meta)));');
    expect(body).not.toContain('emit(serialize(level, msg, meta));');
  });

  it('имя автотеста из списка исключений убрано', () => {
    const body = codeOnly(read('core/logger.ts'));
    expect(body).not.toContain("msg === 'auto_test_identity'");
  });
});
