/**
 * Окно приёма и отметка «докуда прочитано» — два места, где месячное хранение
 * на relay молча превращалось обратно в недельное или в «прочитано, но не
 * разобрано».
 *
 * v4.32.614. Два измеренных дефекта:
 *
 *  1. relay держит накопленное 30 суток и отдаёт его целиком при подписке, а
 *     приём выбрасывал всё старше 7 суток — и сообщения, и публикации. То есть
 *     человек, не заходивший две недели, скачивал всё, что его ждало, и не
 *     видел из этого ничего.
 *  2. отметка последнего принятого кадра ставилась ДО разбора. Кадр, на
 *     котором разбор упал, больше не запрашивался никогда: relay его хранит, а
 *     мы его уже «прочитали».
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RELAY_RETENTION_MS, RELAY_RETENTION_PARAM } from '../../retentionWindow';
import { RELAY_RETENTION_MS as VIA_BACKLOG, BACKLOG_FALLBACK } from '../relayBacklog';

function read(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', '..', '..', rel), 'utf8');
}

describe('срок один на всех', () => {
  it('тридцать суток — и хранение, и приём', () => {
    expect(RELAY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(VIA_BACKLOG).toBe(RELAY_RETENTION_MS);
    expect(BACKLOG_FALLBACK).toBe(RELAY_RETENTION_PARAM);
  });

  it('go-duration, а не 30d: на 30d ntfy отвечает 400', () => {
    expect(RELAY_RETENTION_PARAM).toBe('720h');
    expect(RELAY_RETENTION_PARAM).toMatch(/^\d+[hms]$/);
    expect(Number.parseInt(RELAY_RETENTION_PARAM, 10) * 60 * 60 * 1000).toBe(RELAY_RETENTION_MS);
  });

  it('личные сообщения берут срок из общего модуля, а не своей копией числа', () => {
    const src = read('core/social/messaging.ts');
    expect(src).toContain("import { RELAY_RETENTION_MS } from '../transport/retentionWindow';");
    expect(src).toContain('const ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;');
    expect(src).not.toContain('const ENVELOPE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;');
  });

  it('лента берёт срок оттуда же', () => {
    const src = read('core/social/feedTransport.ts');
    expect(src).toContain("import { RELAY_RETENTION_MS } from '../transport/retentionWindow';");
    expect(src).toContain('export const FEED_ENVELOPE_MAX_AGE_MS = RELAY_RETENTION_MS;');
    expect(src).not.toContain('FEED_ENVELOPE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;');
  });

  it('пятиминутный зазор вперёд остался: он про часы, а не про хранение', () => {
    const src = read('core/social/messaging.ts');
    expect(src).toContain('const ENVELOPE_MAX_SKEW_MS = 5 * 60 * 1000;');
  });
});

describe('отметка двигается только по разобранному', () => {
  const src = read('core/transport/internet/internetCoordinator.ts');
  const transport = read('core/transport/internet/internetTransport.ts');

  it('колбэка «кадр увиден» больше нет ни в транспорте, ни в координаторе', () => {
    // Имя осталось только в объяснении, зачем его убрали, — кода за ним нет.
    expect(transport).not.toContain('this.onFrameSeen');
    expect(transport).not.toContain('onFrameSeen?:');
    expect(src).not.toContain('onFrameSeen');
  });

  it('время кадра приходит вместе с кадром', () => {
    expect(transport).toContain('this.onFrame?.(senderDid, payload, frameAt);');
    expect(src).toContain('onFrame: (senderDid, payload, frameAtMs) => {');
  });

  it('продвижение стоит после разбора, а не перед ним', () => {
    // v4.32.730: мест вызова стало два. Первое — намеренная сдача (`giveUp`),
    // второе — успех. Порядок в файле и есть проверяемое: ни одно продвижение
    // не стоит раньше, чем у кадра появился исход.
    const giveUpAt = src.indexOf('const giveUp = ');
    const consumedAt = src.indexOf("if (intake === 'consumed') {");
    expect(giveUpAt).toBeGreaterThan(0);
    expect(consumedAt).toBeGreaterThan(giveUpAt);
    // v4.32.831: продвижение зовётся через markDone — он помнит, докуда пачка
    // уже закончена, потому что кадры заканчиваются не в том порядке, в каком
    // пришли.
    expect(src.indexOf('markDone(frameAtMs);')).toBeGreaterThan(giveUpAt);
    expect(src.indexOf('markDone(frameAtMs);', consumedAt)).toBeGreaterThan(consumedAt);
  });

  it('все три ветки приёма дожидаются разбора и читают его исход', () => {
    // v4.32.730: приёмник отвечает словом, а не молчанием. Присваивание в
    // `intake` — и есть то, что раньше выбрасывалось.
    expect(src).toContain('intake = await receiveFeedEnvelope(payload, senderDid);');
    expect(src).toContain(
      'await getGroupMessagingService()?.receiveGroupEnvelope(payload, senderDid)) ??',
    );
    expect(src).toContain(
      'await getMessagingService()?.receiveDirectLanEnvelope(payload, senderDid)) ??',
    );
  });

  it('службы ещё нет — кадр отложен, а не прочитан', () => {
    // Холодный старт: накопленное приходит раньше, чем поднялась переписка.
    // `?? 'deferred'` — единственное, что отличает «некому разбирать» от
    // «разобрано». Без него кадр терялся навсегда.
    expect(src.match(/\?\?\n?\s*'deferred';/g) ?? []).toHaveLength(2);
  });

  it('упавший кадр держит отметку, но не навсегда', () => {
    expect(src).toContain('failedOnce');
    expect(src).toContain('if (failedOnce.has(frameAtMs)) {');
    // Второй провал того же кадра отпускает отметку — иначе накопленное
    // качалось бы по кругу при каждом подключении.
    expect(src).toContain('internet_frame_handle_failed_again');
    expect(src).toContain('internet_frame_deferred_again');
    // v4.32.831: потолок остался только у памяти о провалах. Прежний сбрасывал
    // заодно и удержания — то есть пятьсот отложенных кадров разом переставали
    // держать отметку, и следующий же удачный кадр перешагивал их все.
    expect(src).toContain('if (failedOnce.size > 512) failedOnce.clear();');
    expect(src).not.toContain('held.clear();');
  });

  it('удержанный кадр не даёт соседнему унести отметку за себя', () => {
    // v4.32.730. Транспорт зовёт onFrame на каждое сообщение WS, не дожидаясь
    // разбора предыдущего, а отметка двигалась только вперёд — и удачный сосед
    // уносил её за кадр, который мы собирались перезапросить. То есть удержание
    // не работало ни в одной пачке длиннее одного кадра.
    expect(src).toContain('const held = new Set<number>();');
    expect(src).toContain('for (const h of held) if (h <= target) target = h - 1;');
    // Поведение этого места проверяется отдельно: backlogIntake730.test.ts.
  });
});
