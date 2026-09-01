/**
 * v4.32.470 — рэтчет: очередь отправки не путает аккаунты.
 *
 * Дефект. Номер активного профиля брался ОДИН раз, до цикла (`activePid`), а
 * сама отправка каждой строки идёт дальше по циклу и упирается в сеть. За это
 * время человек успевает переключить аккаунт: `getMessagingService()`, который
 * спрашивают внутри цикла, отдаёт уже другую службу — с другой парой ключей.
 * Личное сообщение, поставленное в очередь в личном профиле, уходило
 * подписанным ключом рабочего.
 *
 * Тест держит форму починки, а не текст: сверка стоит перед отправкой, берёт
 * владельца у самой службы (а не у глобального состояния), и отказ идёт по
 * ветке «отложено» — попытка не тратится.
 */
import * as fs from 'fs';
import * as path from 'path';

const SYNC = fs.readFileSync(path.join(__dirname, '..', 'sync.ts'), 'utf8');
const MSG = fs.readFileSync(
  path.join(__dirname, '..', '..', 'social', 'messaging.ts'),
  'utf8'
);

/** Тело функции: от строки объявления до закрывающей скобки в нулевой колонке. */
function bodyOf(src: string, head: string): string {
  const start = src.indexOf(head);
  if (start < 0) throw new Error('не найдено: ' + head);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end < 0 ? undefined : end);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('проверка не пустая', () => {
  it('исходники прочитаны, помощники работают', () => {
    expect(SYNC.length).toBeGreaterThan(2000);
    expect(count('a b a', 'a')).toBe(2);
    expect(bodyOf('function f() {\n  return 1;\n}\n', 'function f() {')).toContain('return 1;');
  });
});

describe('владелец строки сверяется со службой', () => {
  const HELPER = bodyOf(SYNC, 'async function serviceForItem(');

  it('помощник есть и он один', () => {
    expect(count(SYNC, 'async function serviceForItem(')).toBe(1);
  });

  it('владелец берётся у службы, а не у глобального состояния', () => {
    expect(HELPER).toContain('await svc.ownerProfileId()');
    expect(HELPER).not.toContain('profileManager');
    expect(HELPER).not.toContain('activePid');
  });

  it('несовпадение — это «отложено», а не потраченная попытка', () => {
    expect(HELPER).toContain("kind: 'deferred', reason: 'service_other_profile'");
    expect(HELPER).not.toContain("kind: 'failed'");
    expect(HELPER).not.toContain("kind: 'delivered'");
  });

  it('строки старых версий без владельца отправляются как раньше', () => {
    expect(HELPER).toContain("if (item.ownerProfileId === null) return { kind: 'ready', svc };");
  });

  it('отсутствие службы по-прежнему откладывает, а не роняет', () => {
    expect(HELPER).toContain("reason: 'no_messaging_service'");
  });

  it('несовпадение попадает в журнал вместе с обоими номерами', () => {
    expect(HELPER).toContain("log.info('outbox_service_other_profile'");
    expect(HELPER).toContain('itemPid: item.ownerProfileId');
    expect(HELPER).toContain('svcPid');
  });
});

describe('отправка идёт только через сверку', () => {
  const LOOP = SYNC.slice(SYNC.indexOf('for (const item of batch) {'));

  it('обе повторные отправки спрашивают serviceForItem', () => {
    expect(count(LOOP, 'const service = await serviceForItem(item);')).toBe(2);
    expect(count(LOOP, 'service.svc.retrySendDm(p)')).toBe(1);
    expect(count(LOOP, 'service.svc.retrySendCtl(p)')).toBe(1);
  });

  it('в цикле отправки службу больше не берут напрямую', () => {
    expect(LOOP).not.toContain('getMessagingService()');
  });

  it('прямой вызов службы остался ровно один — внутри помощника', () => {
    expect(count(SYNC, 'const svc = getMessagingService();')).toBe(1);
  });

  it('сверка стоит ДО отправки, а не после', () => {
    const check = LOOP.indexOf('const service = await serviceForItem(item);');
    const send = LOOP.indexOf('service.svc.retrySendDm(p)');
    expect(check).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(check);
  });
});

describe('служба умеет назвать своего владельца', () => {
  it('метод публичный — иначе очередь не смогла бы спросить', () => {
    expect(MSG).toContain('  async ownerProfileId(): Promise<number> {');
    expect(MSG).not.toContain('private async ownerProfileId(');
  });

  it('ответ выводится из пары ключей и запоминается', () => {
    const body = bodyOf(MSG, '  async ownerProfileId(): Promise<number> {');
    expect(body).toContain('if (this.ownerPid !== null) return this.ownerPid;');
    expect(body).toContain('this.lookupOwnerPid()');
  });

  it('предварительный отсев по активному профилю остался — он дешевле', () => {
    expect(SYNC).toContain("log.info('outbox_skip_other_profile'");
  });
});
