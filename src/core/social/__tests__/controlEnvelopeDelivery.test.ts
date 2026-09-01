/**
 * controlEnvelopeDelivery — «удалить у всех» и «изменить у всех» доходят так же,
 * как обычное сообщение (v4.32.431).
 *
 * ДЕФЕКТ, который сторожит этот тест. Обычная отправка проходит четыре ступени:
 * IPFS → self-inbox → прямой транспорт → gossip → очередь. Оба служебных
 * конверта обрывались на первой (`if (!cid) return null`), а первая ступень на
 * телефоне не работает вовсе: `isIpfsEnabled()` возвращает false на android и
 * ios, то есть `publishMessageWithRetry` там всегда null. Ветка, написанная
 * как редкий фолбэк, была единственным живым путём — и служебные конверты в
 * него не заходили. Вдобавок у удаления локальная часть стояла ПОСЛЕ выхода по
 * null, поэтому «Удалить у всех» не удаляло сообщение даже у самого человека.
 *
 * Тест проверяет форму, а не поведение сети: важно, что обе операции ходят
 * через один общий путь и что удаление у себя происходит раньше сетевой части.
 */
import * as fs from 'fs';
import * as path from 'path';

const SOCIAL = path.join(__dirname, '..');
const MESSAGING = fs.readFileSync(path.join(SOCIAL, 'messaging.ts'), 'utf8');
const SYNC = fs.readFileSync(path.join(SOCIAL, '..', 'storage', 'sync.ts'), 'utf8');
const CHAT_SCREEN = fs.readFileSync(
  path.join(SOCIAL, '..', '..', 'ui', 'screens', 'ChatScreen.tsx'),
  'utf8'
);

/** Тело метода класса: от строки объявления до закрывающей скобки того же отступа. */
function methodBody(source: string, name: string): string {
  const start = source.includes(`  async ${name}(`)
    ? source.indexOf(`  async ${name}(`)
    : source.indexOf(`  private async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }\n', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function codeOnly(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('служебный конверт идёт общим путём', () => {
  it('IPFS остаётся выключенным на телефоне — предпосылка дефекта не изменилась', () => {
    const helia = fs.readFileSync(
      path.join(SOCIAL, '..', 'transport', 'ipfs', 'heliaNode.ts'),
      'utf8'
    );
    expect(helia).toContain("if (Platform.OS !== 'android' && Platform.OS !== 'ios') return true;");
    // Если эта строка когда-нибудь исчезнет, дефект перестанет быть
    // стопроцентным — но лестница фолбэков всё равно обязана остаться.
    expect(codeOnly(MESSAGING)).toContain('if (!isIpfsEnabled()) return null;');
  });

  it('в IPFS публикует только три места, и служебные конверты не среди них', () => {
    // sendMessageWork, retrySendDm и общий deliverControlEnvelope. Больше
    // прямых публикаций быть не должно: у каждой своя лестница фолбэков, и
    // именно так у служебных конвертов её когда-то не оказалось вовсе.
    const calls = codeOnly(MESSAGING).match(/publishMessageWithRetry\(this\.store/g) ?? [];
    expect(calls).toHaveLength(3);
    expect(codeOnly(methodBody(MESSAGING, 'sendDeleteTombstone'))).not.toContain('publishMessageWithRetry');
    expect(codeOnly(methodBody(MESSAGING, 'editMessage'))).not.toContain('publishMessageWithRetry');
  });

  it('общий путь пробует все ступени, а не только первую', () => {
    const body = codeOnly(methodBody(MESSAGING, 'deliverControlEnvelope'));
    expect(body).toContain('publishMessageWithRetry');
    expect(body).toContain('publishToSelfInbox');
    expect(body).toContain('multiTransportRouter.send');
    expect(body).toContain('this.gossipDmToContacts');
  });

  it('удаление у себя происходит раньше сетевой части', () => {
    const body = codeOnly(methodBody(MESSAGING, 'sendDeleteTombstone'));
    const local = body.indexOf('await deleteChatMessage(');
    const network = body.indexOf('buildControlEnvelope(');
    expect(local).toBeGreaterThan(-1);
    expect(network).toBeGreaterThan(local);
    // v4.32.555: до локального удаления не должно быть ВООБЩЕ никакой проверки
    // сети. В v4.32.550 здесь стоял `requireOnlineWrite`, и без интернета своя
    // строка не удалялась вовсе — ровно тот дефект, который чинили в 431.
    expect(body.slice(0, local)).not.toContain('requireOnlineWrite');
    expect(body.slice(0, local)).not.toContain('checkOnlineWrite');
    expect(body.indexOf('checkOnlineWrite(')).toBeGreaterThan(local);
  });

  it('правка у себя тоже идёт первой', () => {
    const body = codeOnly(methodBody(MESSAGING, 'editMessage'));
    const local = body.indexOf('await updateChatMessageText(');
    expect(local).toBeGreaterThan(-1);
    expect(body.slice(0, local)).not.toContain('requireOnlineWrite');
    expect(body.slice(0, local)).not.toContain('checkOnlineWrite');
    expect(body.indexOf('buildControlEnvelope(')).toBeGreaterThan(local);
  });

  it('обе операции не создают новую offline-очередь', () => {
    expect(codeOnly(methodBody(MESSAGING, 'sendDeleteTombstone'))).not.toContain('outboxEnqueue(');
    expect(codeOnly(methodBody(MESSAGING, 'editMessage'))).not.toContain('outboxEnqueue(');
  });

  it('очередь умеет разбирать этот вид — иначе строки копились бы навсегда', () => {
    expect(SYNC).toContain("item.kind === 'ctl'");
    expect(SYNC).toContain('parseCtlRetryPayload');
    expect(SYNC).toContain('retrySendCtl');
    // 'ctl' не должен попасть под правило «IPFS-only виды выбрасываем на телефоне».
    expect(SYNC).toContain("(item.kind === 'msg' || item.kind === 'blob')");
    expect(SYNC).not.toContain("item.kind === 'ctl' || item.kind === 'msg'");
  });

  it('исход сообщают человеку во всех трёх местах, одним правилом', () => {
    const uses = CHAT_SCREEN.match(/reportTwoSided\(/g) ?? [];
    expect(uses).toHaveLength(3);
    // Ни один вызов не выбрасывает результат молча.
    const ignored = CHAT_SCREEN.split('\n').filter(
      (l) =>
        (l.includes('deleteMessageForEveryone(') || l.includes('.editMessage(')) &&
        !l.includes('echo')
    );
    expect(ignored).toEqual([]);
    // Формулировка «нет связи с облаком» была неправдой: у себя не удалялось.
    expect(CHAT_SCREEN).not.toContain('нет связи с облаком');
  });
});
