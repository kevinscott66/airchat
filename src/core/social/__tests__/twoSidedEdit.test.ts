/**
 * v4.32.555. «Удалить у всех» и «Изменить у всех» офлайн не делали ничего, но
 * текст утверждал обратное.
 *
 * В v4.32.550 обе операции начинались с проверки сети: `requireOnlineWrite`
 * бросал исключение, метод возвращал 'unreachable', и до локального удаления
 * дело не доходило. Человек видел «Сообщение удалено у вас, но собеседнику
 * отправить не удалось» — при том что сообщение оставалось на экране. Ровно
 * этот дефект чинили в v4.32.431, и он вернулся.
 *
 * Здесь проверяется правило целиком: локальная половина идёт первой и от сети
 * не зависит, сеть спрашивают только ради второй половины, а исход — три
 * разных случая, не два.
 */
import fs from 'fs';
import path from 'path';
import {
  combineHalves,
  localHalfDone,
  peerHalfDone,
  shouldTryPeerHalf,
} from '../twoSidedEdit';

const read = (rel: string): string =>
  fs.readFileSync(path.join(__dirname, rel), 'utf8');

const MODULE = (): string => read('../twoSidedEdit.ts');
const MESSAGING = (): string => read('../messaging.ts');
const LOCAL = (): string => read('../../storage/local.ts');
const FEEDBACK = (): string => read('../../../ui/components/userFeedback.ts');

describe('исход операции из двух половин', () => {
  it('обе половины удались — сделано у всех', () => {
    expect(combineHalves(true, 'sent')).toBe('both-sides');
  });

  it('своя половина есть, до собеседника не дошло — только у себя', () => {
    expect(combineHalves(true, 'unreachable')).toBe('your-side-only');
  });

  it('своя половина не удалась — не произошло ничего, что бы ни ответила сеть', () => {
    expect(combineHalves(false, 'unreachable')).toBe('nothing-happened');
    // Главное: даже успешная отправка не делает из провала «удалено у вас».
    expect(combineHalves(false, 'sent')).toBe('nothing-happened');
  });

  it('локальная половина считается сделанной в двух исходах из трёх', () => {
    expect(localHalfDone('both-sides')).toBe(true);
    expect(localHalfDone('your-side-only')).toBe(true);
    expect(localHalfDone('nothing-happened')).toBe(false);
  });

  it('до собеседника дошло только в одном', () => {
    expect(peerHalfDone('both-sides')).toBe(true);
    expect(peerHalfDone('your-side-only')).toBe(false);
    expect(peerHalfDone('nothing-happened')).toBe(false);
  });
});

describe('когда вообще браться за сетевую половину', () => {
  it('локальная сделана и сеть есть — пробуем', () => {
    expect(shouldTryPeerHalf(true, true)).toBe(true);
  });

  it('локальная сделана, сети нет — не пробуем, но это не отменяет локальную', () => {
    expect(shouldTryPeerHalf(true, false)).toBe(false);
    expect(combineHalves(true, 'unreachable')).toBe('your-side-only');
    expect(localHalfDone(combineHalves(true, 'unreachable'))).toBe(true);
  });

  it('локальная не удалась — отправлять нечего даже при живой сети', () => {
    expect(shouldTryPeerHalf(false, true)).toBe(false);
    expect(shouldTryPeerHalf(false, false)).toBe(false);
  });
});

describe('форма исходников', () => {
  it('правило живёт в модуле без зависимостей', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });

  it('обе операции больше не начинаются с проверки сети', () => {
    const src = MESSAGING();
    // Строка из v4.32.550, которая и отменяла локальную половину.
    expect(src).not.toContain(
      "try { await requireOnlineWrite(await localPathTo(contactPubB64)); } catch { return 'unreachable'; }"
    );
    // Проверка сети осталась, но теперь она решает судьбу только второй половины.
    expect(src.match(/shouldTryPeerHalf\(localDone, online\.ok\)/g)).toHaveLength(2);
  });

  it('локальная половина идёт до вопроса о сети в обеих операциях', () => {
    const src = MESSAGING();
    for (const [local, network] of [
      ['const localDone = await deleteChatMessage(', 'checkOnlineWrite('],
      ['const localDone = await updateChatMessageText(', 'checkOnlineWrite('],
    ]) {
      const at = src.indexOf(local);
      expect(at).toBeGreaterThan(-1);
      expect(src.indexOf(network, at)).toBeGreaterThan(at);
    }
  });

  it('исход собирают одним правилом, а не строкой на месте', () => {
    const src = MESSAGING();
    expect(src.match(/combineHalves\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    // Прежние ответы «одним словом про сеть» должны были исчезнуть.
    expect(src).not.toMatch(/^\s+return 'unreachable';$/m);
  });

  it('база сообщает, удалась ли локальная половина', () => {
    const src = LOCAL();
    expect(src).toContain(
      'export async function deleteChatMessage(id: string, ownerProfileId: number): Promise<boolean>'
    );
    expect(src).toContain('export async function updateChatMessageText(');
    // Обе функции обещают именно boolean, а не молчаливый void.
    expect(src.match(/ownerProfileId: number\n\): Promise<boolean> \{/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('человеку говорят про все три исхода', () => {
    const src = FEEDBACK();
    expect(src).toContain('export function reportTwoSided(');
    expect(src).not.toContain('export function reportPeerEcho(');
    expect(src).toContain('localHalfDone(outcome)');
    expect(src).toContain('peerHalfDone(outcome)');
    // Провал больше не выдаётся за «удалено у вас».
    expect(src).toContain('Не удалось ${verb} сообщение');
  });
});
