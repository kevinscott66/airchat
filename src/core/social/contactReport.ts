/**
 * contactReport — «Пожаловаться» на собеседника (v4.32.568).
 *
 * Честная граница, и она здесь важнее самого кода. В AirChat нет модерации:
 * переписка сквозная, сервер видит только зашифрованные пакеты, единого
 * оператора, которому можно передать жалобу, не существует. Поэтому жалоба
 * никуда не отправляется — и в интерфейсе про это сказано теми же словами.
 *
 * Что она делает на самом деле:
 *   — записывает решение в локальный журнал (кто, когда, за что), чтобы у
 *     человека остался собственный след: у кого он это увидел и что сделал;
 *   — по умолчанию блокирует отправителя — единственное действие, которое в
 *     сети без модератора действительно прекращает поток от него.
 *
 * Журнал профильный и локальный. Он не уходит ни собеседнику, ни на сервер.
 */

import { scopedKvGet, scopedKvSet } from '../storage/profileScopedKv';
import { log } from '../logger';

export type ReportReason = 'spam' | 'abuse' | 'fraud' | 'illegal' | 'other';

export const REPORT_REASONS: ReadonlyArray<{ id: ReportReason; label: string }> = [
  { id: 'spam', label: 'Спам и навязчивая реклама' },
  { id: 'abuse', label: 'Оскорбления и угрозы' },
  { id: 'fraud', label: 'Мошенничество' },
  { id: 'illegal', label: 'Запрещённые материалы' },
  { id: 'other', label: 'Другое' },
];

export type ContactReport = {
  /** did:key собеседника — публичный идентификатор, его можно писать в журнал. */
  did: string;
  reason: ReportReason;
  at: number;
  /** Заблокировали ли его тем же действием. */
  blocked: boolean;
};

const KEY = 'contact_reports';
/** Потолок журнала: он нужен как след, а не как архив. */
const MAX_REPORTS = 200;

function parseReports(raw: string | null): ContactReport[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((r): r is ContactReport =>
      !!r && typeof r === 'object'
      && typeof (r as ContactReport).did === 'string'
      && typeof (r as ContactReport).at === 'number');
  } catch {
    // Испорченный журнал — это пустой журнал, а не отказ открыть карточку.
    return [];
  }
}

export async function listContactReports(): Promise<ContactReport[]> {
  try {
    return parseReports(await scopedKvGet(KEY));
  } catch (e) {
    log.warn('contact_reports_read_failed', { err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Была ли уже жалоба на этого человека. Карточка подписывает пункт по-другому. */
export async function hasReported(did: string): Promise<boolean> {
  return (await listContactReports()).some((r) => r.did === did);
}

/**
 * Записать жалобу. Блокировку выполняет вызывающий: она принадлежит
 * rateLimiter, и тянуть его сюда ради одного вызова незачем — сюда приезжает
 * только ответ «заблокировали ли».
 */
export async function recordContactReport(
  did: string,
  reason: ReportReason,
  blocked: boolean,
): Promise<void> {
  const prev = await listContactReports();
  const next = [{ did, reason, at: Date.now(), blocked }, ...prev].slice(0, MAX_REPORTS);
  await scopedKvSet(KEY, JSON.stringify(next));
  log.info('contact_reported', { reason, blocked });
}
