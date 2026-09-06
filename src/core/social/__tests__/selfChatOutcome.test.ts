import fs from 'fs';
import path from 'path';
import { hasPeerHalf, localHalfDone, peerHalfDone, selfChatOutcome } from '../twoSidedEdit';

describe('selfChatOutcome — «Заметки для себя»', () => {
  it('удавшаяся правка своей заметки — это не «не удалось отправить»', () => {
    const outcome = selfChatOutcome(true);
    expect(localHalfDone(outcome)).toBe(true);
    expect(hasPeerHalf(outcome)).toBe(false);
    // Ключевое: исход не должен читаться как удача доставки собеседнику…
    expect(peerHalfDone(outcome)).toBe(false);
    // …и одновременно не должен попадать в ветку «у вас, но собеседнику не удалось».
    expect(outcome).toBe('no-peer-half');
  });

  it('неудавшаяся правка остаётся неудачей', () => {
    const outcome = selfChatOutcome(false);
    expect(localHalfDone(outcome)).toBe(false);
    expect(hasPeerHalf(outcome)).toBe(true);
  });

  it('у обычной переписки вторая половина есть', () => {
    expect(hasPeerHalf('both-sides')).toBe(true);
    expect(hasPeerHalf('your-side-only')).toBe(true);
    expect(hasPeerHalf('nothing-happened')).toBe(true);
  });
});

/**
 * Порядок в исходнике: собеседника проверяют ПОСЛЕ того, как своя половина
 * сделана, и ДО того, как спрашивают сеть. Иначе «Заметки для себя» опять
 * пойдут звонить в облако ради адресата, которого нет.
 */
describe('исходный текст: переписка с самим собой не идёт в сеть', () => {
  const messaging = (): string =>
    fs.readFileSync(path.join(__dirname, '../messaging.ts'), 'utf8');
  const feedback = (): string =>
    fs.readFileSync(path.join(__dirname, '../../../ui/components/userFeedback.ts'), 'utf8');

  const orderIn = (src: string, from: string, marks: string[]): number[] => {
    const start = src.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    return marks.map((m) => src.indexOf(m, start));
  };

  it('editMessage: своя строка → проверка на себя → сеть', () => {
    const [local, self, net] = orderIn(messaging(), '  async editMessage(', [
      'const localDone = await updateChatMessageText(',
      'if (this.isSelfChat(contactPubB64)) return selfChatOutcome(localDone);',
      'checkOnlineWrite(',
    ]);
    expect(self).toBeGreaterThan(local);
    expect(net).toBeGreaterThan(self);
  });

  it('sendDeleteTombstone: тот же порядок', () => {
    const [local, self, net] = orderIn(messaging(), '  async sendDeleteTombstone(', [
      'const localDone = await deleteChatMessage(',
      'if (this.isSelfChat(contactPubB64)) return selfChatOutcome(localDone);',
      'checkOnlineWrite(',
    ]);
    expect(self).toBeGreaterThan(local);
    expect(net).toBeGreaterThan(self);
  });

  it('уведомление разбирает «второй половины нет» раньше, чем «дошло до всех»', () => {
    const src = feedback();
    const noPeer = src.indexOf('if (!hasPeerHalf(outcome))');
    const both = src.indexOf('if (peerHalfDone(outcome))');
    const fail = src.indexOf('но собеседнику отправить не удалось');
    expect(noPeer).toBeGreaterThan(0);
    expect(both).toBeGreaterThan(noPeer);
    expect(fail).toBeGreaterThan(both);
  });
});
