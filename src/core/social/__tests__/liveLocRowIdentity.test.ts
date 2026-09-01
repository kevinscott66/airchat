/**
 * v4.32.568. Живая геолокация заводила новую строку в переписке на каждую
 * посылку — с обеих сторон. Проверяется само правило и то, что оба места,
 * где оно должно применяться, его применяют.
 */
import fs from 'fs';
import path from 'path';

import {
  MAX_LIVE_ID_LEN,
  chatRowIdForLiveLoc,
  decideLiveLocUpdate,
} from '../liveLocRowIdentity';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const MESSAGING = (): string => read('core', 'social', 'messaging.ts');
const MODULE = (): string => read('core', 'social', 'liveLocRowIdentity.ts');

describe('chatRowIdForLiveLoc', () => {
  it('живая геолокация ложится под номер сессии, а не конверта', () => {
    expect(chatRowIdForLiveLoc('live-1', 'envelope-1')).toBe('live-1');
    expect(chatRowIdForLiveLoc('live-1', 'envelope-2')).toBe('live-1');
  });

  it('обычное сообщение остаётся под номером конверта', () => {
    expect(chatRowIdForLiveLoc(null, 'envelope-1')).toBe('envelope-1');
    expect(chatRowIdForLiveLoc(undefined, 'envelope-1')).toBe('envelope-1');
  });

  it('пустой или слишком длинный номер сессии не заменяет номер конверта', () => {
    expect(chatRowIdForLiveLoc('', 'envelope-1')).toBe('envelope-1');
    expect(chatRowIdForLiveLoc('x'.repeat(MAX_LIVE_ID_LEN + 1), 'envelope-1')).toBe('envelope-1');
    expect(chatRowIdForLiveLoc('x'.repeat(MAX_LIVE_ID_LEN), 'envelope-1')).toBe('x'.repeat(MAX_LIVE_ID_LEN));
  });

  it('нестроковый номер сессии не роняет и не подменяет номер строки', () => {
    expect(chatRowIdForLiveLoc(42 as unknown as string, 'envelope-1')).toBe('envelope-1');
    expect(chatRowIdForLiveLoc({} as unknown as string, 'envelope-1')).toBe('envelope-1');
  });

  it('за восемьсот тактов сессии номер строки не меняется ни разу', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 800; i++) ids.add(chatRowIdForLiveLoc('live-1', `envelope-${i}`));
    expect(ids.size).toBe(1);
  });
});

describe('decideLiveLocUpdate', () => {
  it('первая посылка применяется', () => {
    expect(decideLiveLocUpdate(null, { ts: 100 })).toEqual({ kind: 'apply' });
    expect(decideLiveLocUpdate(undefined, { ts: 100 })).toEqual({ kind: 'apply' });
  });

  it('более новая посылка применяется', () => {
    expect(decideLiveLocUpdate({ ts: 100 }, { ts: 130 })).toEqual({ kind: 'apply' });
  });

  it('придержанная и подсунутая позже посылка не отодвигает метку назад', () => {
    expect(decideLiveLocUpdate({ ts: 130 }, { ts: 100 })).toEqual({ kind: 'skip', code: 'stale' });
  });

  it('повтор той же посылки применяется — текст тот же', () => {
    expect(decideLiveLocUpdate({ ts: 100 }, { ts: 100 })).toEqual({ kind: 'apply' });
  });

  it('без времени отправки хоть с одной стороны посылка применяется', () => {
    expect(decideLiveLocUpdate({}, { ts: 100 })).toEqual({ kind: 'apply' });
    expect(decideLiveLocUpdate({ ts: 100 }, {})).toEqual({ kind: 'apply' });
    expect(decideLiveLocUpdate({}, {})).toEqual({ kind: 'apply' });
  });

  it('нечисловое время не превращает сравнение в NaN-отказ', () => {
    expect(decideLiveLocUpdate({ ts: NaN }, { ts: 100 })).toEqual({ kind: 'apply' });
    expect(decideLiveLocUpdate({ ts: 100 }, { ts: Infinity })).toEqual({ kind: 'apply' });
    expect(decideLiveLocUpdate({ ts: '200' as unknown as number }, { ts: 100 })).toEqual({ kind: 'apply' });
  });
});

describe('приём: строка складывается по номеру сессии', () => {
  it('входящая строка получает rowId, а не номер конверта', () => {
    const s = MESSAGING();
    expect(s).toContain('const rowId = chatRowIdForLiveLoc(liveNext?.liveId, em.messageId);');
    expect(s).toContain('    const row: ChatMessageRow = {\n      id: rowId,');
  });

  it('счётчик непрочитанного и плашка спрашивают ту же строку', () => {
    expect(MESSAGING()).toContain(
      'const alreadyStored = (await getChatMessageAuthor(rowId, ownerPid)) != null;'
    );
  });

  it('ветка обновления на месте больше не ищет строку по номеру конверта', () => {
    const s = MESSAGING();
    const at = s.indexOf('if (inbound && liveNext) {');
    expect(at).toBeGreaterThan(-1);
    const branch = s.slice(at, s.indexOf('\n    }\n', at));
    expect(branch).toContain('getChatMessageAuthor(rowId, ownerPid)');
    expect(branch).toContain('updateChatMessageText(rowId, rawText, ownerPid)');
    expect(branch).not.toContain('em.messageId');
  });

  it('проверка авторства из v4.32.239 осталась на месте', () => {
    const s = MESSAGING();
    expect(s).toContain("log.warn('liveloc_update_rejected_authorship'");
    expect(s).toContain("log.warn('liveloc_update_rejected_not_liveloc'");
  });

  it('устаревшая посылка отбрасывается и это видно в журнале', () => {
    const s = MESSAGING();
    expect(s).toContain('decideLiveLocUpdate(prev != null ? parseLiveLoc(prev) : null, liveNext)');
    expect(s).toContain("log.warn('liveloc_update_skipped'");
  });
});

describe('отправка: вторую строку никто не заводит', () => {
  it('живая геолокация не сохраняется отправкой — строку ведёт экран', () => {
    const s = MESSAGING();
    expect(s).toContain('const callerOwnsRow = isLiveLocMessage(text);');
    expect(s).toContain('if (!control && !callerOwnsRow) await upsertChatMessage(row);');
  });

  it('экран по-прежнему кладёт свою строку под номером сессии', () => {
    expect(read('ui', 'screens', 'ChatScreen.tsx')).toContain('upsertChatMessage({ id: payload.liveId,');
  });
});

describe('форма модуля', () => {
  it('модуль без импортов — правило проверяется отдельно от базы и шифрования', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });
});
