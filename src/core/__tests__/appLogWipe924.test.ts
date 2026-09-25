/**
 * Журнал приложения уходит вместе с данными устройства (v4.32.924).
 *
 * Дефект: `airchat-app.log` переживал «Выйти и удалить данные на устройстве».
 * Сброс закрывал базы, стирал их файлы, чистил кэш и аватары — а файл журнала
 * оставался лежать в том же каталоге данных.
 *
 * Цена: журнал — это не содержание переписки, а её опись, и она подробнее,
 * чем кажется: DID собеседников, номера сообщений, состояние молчания,
 * времена сетевых путей. По ней видно, кто с кем и когда переписывался. Хуже
 * того, человек о файле не помнит: заводится он скрытым режимом разработчика,
 * включённым когда-то однажды, и наружу себя не показывает ничем.
 *
 * Правка: `deleteAppLogFile` — отцепить приёмник и удалить файл. Путь берётся
 * из каталога данных, а НЕ из `logPath`: тот заполнен, только пока диагностика
 * включена в этом самом запуске. Файл же обычно достался от прошлого —
 * включили, перезапустили, и `initFileLogging` больше никто не звал. Смотреть
 * на `logPath` значило бы почти всегда не найти ничего и уйти с чистой
 * совестью.
 *
 * Границы: файловая система здесь подменена. Проверяется, ЧТО модуль просит
 * удалить и в каком порядке отцепляет приёмник, а не умение expo удалить файл.
 */
/** Что модуль просил удалить и с какими условиями. */
const mockDeleted: { uri: string; opts: unknown }[] = [];
/** Чем модуль подменял приёмник журнала, по порядку. */
const mockSinkCalls: unknown[] = [];

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/',
  deleteAsync: async (uri: string, opts: unknown): Promise<void> => {
    mockDeleted.push({ uri, opts });
  },
  getInfoAsync: async (): Promise<{ exists: boolean }> => ({ exists: false }),
  writeAsStringAsync: async (): Promise<void> => {},
  readAsStringAsync: async (): Promise<string> => '',
}));

jest.mock('../logger', () => ({
  setFileSink: (fn: unknown): void => {
    mockSinkCalls.push(fn);
  },
}));

import * as FileSystem from 'expo-file-system/legacy';
import * as fileLogSink from '../fileLogSink';

/**
 * Удаление берём через пространство имён намеренно.
 *
 * На коде, где экспорта ещё нет, файл при этом всё равно грузится, и красным
 * становятся ровно проверки поведения — а не контрольная, которая обязана
 * оставаться зелёной в обе стороны.
 */
const deleteAppLogFile = (fileLogSink as Partial<typeof fileLogSink>).deleteAppLogFile;

/** Позвать удаление, честно упав, если его нет. */
async function wipeLog(): Promise<void> {
  if (!deleteAppLogFile) throw new Error('модуль журнала не отдаёт удаление наружу');
  await deleteAppLogFile();
}

beforeEach(() => {
  mockDeleted.length = 0;
  mockSinkCalls.length = 0;
});

describe('сброс уносит файл журнала', () => {
  it('удаляется ровно airchat-app.log в каталоге данных', async () => {
    await wipeLog();

    expect(mockDeleted.map((d) => d.uri)).toEqual(['file:///data/airchat-app.log']);
  });

  it('удаляется и тогда, когда в этом запуске журнал не заводили', async () => {
    // Обычный случай: диагностику включали прошлой жизнью приложения, в этой
    // `initFileLogging` не звали вовсе, и `logPath` пуст. Файл при этом есть.
    await wipeLog();

    expect(mockDeleted).toHaveLength(1);
  });

  it('отсутствие файла — не ошибка', async () => {
    // Диагностику могли не включать никогда. Исключение здесь превратило бы
    // обычный сброс в сброс с «неудавшимся шагом».
    await wipeLog();

    expect(mockDeleted[0].opts).toEqual({ idempotent: true });
  });

  it('приёмник отцеплен, иначе файл написался бы заново', async () => {
    // Запись идёт с задержкой: строки копятся в памяти и уходят на диск через
    // таймер. Живой приёмник воссоздал бы удалённый файл тем же вечером.
    await wipeLog();

    expect(mockSinkCalls).toEqual([null]);
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: подменённая файловая система и правда отвечает', () => {
  it('удаление записывается, а каталог данных назван', async () => {
    // Иначе «удалили ровно один файл» было бы правдой и при модуле, который
    // не делает ничего, — просто потому что записывать удаления некому.
    await FileSystem.deleteAsync('file:///data/probe', { idempotent: true });

    expect(mockDeleted).toEqual([{ uri: 'file:///data/probe', opts: { idempotent: true } }]);
    expect(FileSystem.documentDirectory).toBe('file:///data/');
  });
});
