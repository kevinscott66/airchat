/**
 * Такт живой геолокации больше не объявляет себя доставленным заранее
 * (v4.32.833).
 *
 * Дефект. Экран переписки писал строку такта сразу со `status: 'delivered'`, а
 * ответ отправки не читал вовсе: `await svc.sendMessage(peerB64, txt);` —
 * и всё.
 *
 * Цена. У живой геолокации это единственная строка на всю сессию (см.
 * `callerOwnsRow` в messaging.ts: отправка своей не заводит). Она
 * перезаписывается каждые полминуты, и другого места, где о посылке можно
 * узнать, нет. Без маршрута отправка отвечает `'refused'`, а
 * `requireOnlineWrite` и вовсе бросает — служба сессий такт гасит в журнал.
 * Человек до восьми часов смотрит на двойную галочку и «Доставлено», уверенный,
 * что его ведут; собеседник при этом не получил ни одной точки. Ровно та же
 * подмена, что в v4.32.732 убрали у обычных сообщений.
 *
 * Правка. Строка кладётся со `'sending'`, отправка спрашивается словом
 * (`sendMessageResult`), и по её исходу строка переписывается в `'sent'` или
 * `'failed'`. `'failed'` у этой иконки — ещё и кнопка повтора.
 *
 * Проверяется форма исходника: поведенческого стыка здесь нет — обработчик
 * такта замкнут внутри `useCallback` экрана и наружу не выведен. Цена же
 * проверяется по-настоящему: иконка состояний — чистая таблица, и то, что
 * `'delivered'` говорит «Доставлено», видно прямо в ней.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');
/** Тот же файл без строк-комментариев: свой же разбор не должен себя подтверждать. */
const bare = (src: string): string =>
  src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const CHAT = (): string => bare(read('ui', 'screens', 'ChatScreen.tsx'));

/** Тело обработчика такта — от сборки строки до конца обработчика. */
const tick = (): string => {
  const s = CHAT();
  const at = s.indexOf('        const row = {\n          id: payload.liveId,');
  expect(at).toBeGreaterThan(0);
  const end = s.indexOf('      onExpire:', at);
  expect(end).toBeGreaterThan(at);
  return s.slice(at, end);
};

describe('такт отчитывается о том, что с ним стало', () => {
  it('строка кладётся как «отправляется», а не как доставленная', () => {
    const t = tick();
    expect(t).toContain("await upsertChatMessage({ ...row, status: 'sending' });");
    expect(t).not.toContain("status: 'delivered'");
  });

  it('исход отправки читается словом и решает состояние строки', () => {
    const t = tick();
    const sent = t.indexOf("(await svc.sendMessageResult(peerB64, txt)).outcome !== 'refused'");
    expect(sent).toBeGreaterThan(0);
    // Итоговая запись — строго после ответа отправки.
    expect(t.indexOf("await upsertChatMessage({ ...row, status: ok ? 'sent' : 'failed' });")).toBeGreaterThan(sent);
  });

  it('брошенное исключение не оставляет строку в «отправляется» навсегда', () => {
    const t = tick();
    const thrown = t.indexOf("log.warn('chat_live_location_tick_failed'");
    expect(thrown).toBeGreaterThan(0);
    // Ловушка стоит ВНУТРИ такта, до итоговой записи, а не вокруг неё.
    expect(t.indexOf("status: ok ? 'sent' : 'failed'")).toBeGreaterThan(thrown);
    // И «не отправилось» по умолчанию: признак заводится ложью.
    expect(t.indexOf('let ok = false;')).toBeGreaterThan(0);
    expect(t.indexOf('let ok = false;')).toBeLessThan(thrown);
  });

  it('обе записи такта берут одни и те же поля — строка остаётся одна', () => {
    const t = tick();
    expect(t.split('upsertChatMessage({ ...row,').length - 1).toBe(2);
    expect(t).toContain('createdAt: payload.expireAt - durationMinutes * 60_000,');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: цена подмены видна в самой иконке', () => {
  const ICON = (): string =>
    bare(read('ui', 'screens', 'chat-components', 'MessageStatusIcon.tsx'));

  it('«доставлено» — это двойная галочка и слово вслух', () => {
    const s = ICON();
    const at = s.indexOf("case 'delivered':");
    expect(at).toBeGreaterThan(0);
    const arm = s.slice(at, s.indexOf("case 'sent':", at));
    expect(arm).toContain('checkmark-done');
    expect(arm).toContain('accessibilityLabel="Доставлено"');
  });

  it('«не отправлено» — это ещё и кнопка повтора', () => {
    const s = ICON();
    const at = s.indexOf("case 'failed':");
    expect(at).toBeGreaterThan(0);
    const arm = s.slice(at, at + 400);
    expect(arm).toContain('onPress={onRetry}');
    expect(arm).toContain('accessibilityLabel="Нажмите для повтора"');
  });

  it('иконка рисуется у любого исходящего, включая живую геолокацию', () => {
    const s = ICON();
    expect(s).toContain("if (direction === 'in') return null;");
    // Тип сообщения в этой таблице не спрашивается вовсе.
    expect(s).not.toContain('isLiveLoc');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('служба сессий гасит отказ такта в журнал — узнать о нём больше негде', () => {
    const svc = bare(read('core', 'social', 'liveLocationService.ts'));
    const at = svc.indexOf('await onUpdate(payload);');
    expect(at).toBeGreaterThan(0);
    const tail = svc.slice(at, at + 300);
    expect(tail).toContain('} catch (e) {');
    expect(tail).toContain("log.warn('liveloc_update_failed'");
  });

  it('отправка строки живой геолокации не заводит — своей у неё нет', () => {
    const msg = bare(read('core', 'social', 'messaging.ts'));
    expect(msg).toContain('const callerOwnsRow = isLiveLocMessage(text);');
    expect(msg).toContain("if (control || callerOwnsRow) return 'skipped';");
  });

  it('без маршрута отправка отвечает отказом, а не молчанием', () => {
    const msg = bare(read('core', 'social', 'messaging.ts'));
    expect(msg).toContain("return { outcome: control || callerOwnsRow ? 'refused' : 'stored', cid: null };");
  });

  it('сессия длится до восьми часов — ошибиться есть на сколько', () => {
    const svc = bare(read('core', 'social', 'liveLocationService.ts'));
    expect(svc).toMatch(/480/);
  });
});
