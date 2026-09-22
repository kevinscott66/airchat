/**
 * Раздача журнала ядра нескольким читателям сразу.
 *
 * Зачем это понадобилось. У логгера ядра ровно одно место для приёмника
 * (`setFileSink` — см. `src/core/logger.ts`), и первый этап занял его файлом.
 * Второму читателю места нет, а он нужен: половина отказов ядра наружу
 * выглядит одинаково.
 *
 * Пример, ради которого всё написано. `sendMessage` отвечает `null` и когда
 * контакт заблокирован, и когда сработал часовой лимит, и когда нет общего
 * ключа, и когда конверт некуда отправить. Агенту, который получит от нас
 * «не получилось», эти четыре случая различать нечем, а действия у них
 * противоположные: блокировку снимает человек, лимит проходит сам, отсутствие
 * ключа лечится добавлением контакта заново. Различает их только журнал — там
 * у каждого отказа своё имя (`dm_send_blocked`, `dm_send_rate_limited`,
 * `dm_no_session`, `dm_send_no_online_route`).
 *
 * Отсюда правило: не трогать ядро ради причин отказа, а слушать то, что оно и
 * так говорит. Вызов оборачивается в `captureLog`, строки, написанные за время
 * вызова, остаются у вызывающего, и он отвечает агенту по имени отказа, а не
 * по пустому `null`.
 *
 * Чего этот приём НЕ делает. Он не разбирает чужие строки: журнал общий на
 * процесс, и если два вызова идут одновременно, каждый увидит и чужие записи.
 * Поэтому места, где имя отказа что-то решает, выстраиваются в очередь
 * (см. `mcp/tools.ts`), а не полагаются на то, что в журнале окажется только
 * своё.
 */
import * as fs from 'node:fs';

import { setFileSink } from '../../src/core/logger';

export type LogEntry = {
  ts?: string;
  level?: string;
  msg?: string;
  meta?: Record<string, unknown>;
  /** Исходная строка: на случай, если JSON не разобрался. */
  raw: string;
};

type Tap = (entry: LogEntry) => void;

const taps = new Set<Tap>();
let fileAppend: ((line: string) => void) | null = null;
let installed = false;

function parse(line: string): LogEntry {
  try {
    const obj = JSON.parse(line) as Omit<LogEntry, 'raw'>;
    return { ...obj, raw: line };
  } catch {
    return { raw: line };
  }
}

function fanout(line: string): void {
  fileAppend?.(line);
  if (taps.size === 0) return;
  const entry = parse(line);
  for (const tap of taps) {
    try {
      tap(entry);
    } catch {
      /* читатель журнала не имеет права ронять того, кого читает */
    }
  }
}

/**
 * Поставить приёмник и направить его в файл.
 *
 * Пишется синхронно и дописыванием: причина отказа нужна ровно в том порядке,
 * в каком она случилась, а процесс, который упал, не успеет слить буфер.
 * Права 0600 — в строках бывают DID и адреса пиров.
 */
export function attachLogSink(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, 'a', 0o600));
  } catch {
    /* не смогли создать — записи просто не лягут, ядро от этого не падает */
  }
  fileAppend = (line: string) => {
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* логирование не имеет права ронять то, что логирует */
    }
  };
  if (!installed) {
    setFileSink(fanout);
    installed = true;
  }
}

/** Снять приёмник. Подписки при этом сохраняются — они переживут перезапуск ядра. */
export function detachLogSink(): void {
  fileAppend = null;
  if (installed) {
    setFileSink(null);
    installed = false;
  }
}

/** Подписаться на строки журнала. Возвращает отписку. */
export function tapLog(tap: Tap): () => void {
  taps.add(tap);
  return () => {
    taps.delete(tap);
  };
}

/**
 * Выполнить работу, запомнив всё, что ядро сказало за это время.
 *
 * Запись идёт синхронно из самого `log.*`, поэтому к моменту возврата в
 * списке уже лежат все строки, написанные до последнего `await` внутри `fn`.
 * Строки, которые ядро допишет позже (отложенная отправка, фоновая уборка),
 * сюда не попадут — и не должны: вызывающий отвечает за свой вызов, а не за
 * всё, что случилось в процессе.
 */
export async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; entries: LogEntry[] }> {
  const entries: LogEntry[] = [];
  const off = tapLog((e) => entries.push(e));
  try {
    const value = await fn();
    return { value, entries };
  } finally {
    off();
  }
}
