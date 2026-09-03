/**
 * «Избранное» — переписка без собеседника (v4.32.560).
 *
 * Дефект. Открытие своей же переписки встречало человека окном «Нет
 * защищённого канала с этим контактом. Добавьте его заново по QR-коду или
 * ссылке». Совет неисполним — себя по QR не добавить, — а причина такая: при
 * открытии переписки уходят два служебных конверта (свой профиль и решение о
 * времени последнего входа), оба через обычную отправку. Та ищет общий ключ с
 * «собеседником», своей строки в контактах нет с v4.32.31, неявный контакт с
 * самим собой тоже не заводится — и путь кончается отказом NO_SESSION_DM.
 *
 * Тем же отказом кончалось всё, что экран переписки не сохранял сам: снимок,
 * документ, точка на карте, визитка, опрос, пересылка. Своими были только
 * текст, голос и GIF — их экран кладёт в базу напрямую.
 *
 * Поэтому своя переписка теперь обрабатывается в одном месте — saveToSelfChat,
 * до всех проверок отправки, — а экран не шлёт самому себе служебных
 * конвертов вовсе.
 */
import fs from 'fs';
import path from 'path';

import { didFromPubB64, publicKeyToDidKey } from '../../identity/did';
import { publicKeyToB64 } from '../../crypto/pubKeyFormat';

const MESSAGING = fs.readFileSync(path.join(__dirname, '..', 'messaging.ts'), 'utf8');
const CHAT_SCREEN = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'ChatScreen.tsx'),
  'utf8',
);

/** Тело метода от его заголовка до заголовка следующего (по отступу в два пробела). */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const end = rest.indexOf('\n  }\n');
  expect(end).toBeGreaterThan(-1);
  return rest.slice(0, end);
}

describe('свой ключ узнаётся по did, а не по строке', () => {
  const key = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

  it('одна и та же пара ключей записана строкой по-разному, did — один', () => {
    const plain = publicKeyToB64(key);
    const urlSafe = plain.replace(/\+/g, '-').replace(/\//g, '_');
    const unpadded = plain.replace(/=+$/, '');
    // Ровно поэтому сравнение строк не годится: три записи одного ключа.
    expect(new Set([plain, urlSafe, unpadded]).size).toBeGreaterThan(1);
    const mine = publicKeyToDidKey(key);
    expect(didFromPubB64(plain)).toBe(mine);
    expect(didFromPubB64(urlSafe)).toBe(mine);
    expect(didFromPubB64(unpadded)).toBe(mine);
  });

  it('чужой ключ своим не считается', () => {
    const other = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
    expect(didFromPubB64(publicKeyToB64(other))).not.toBe(publicKeyToDidKey(key));
  });

  it('испорченная строка не превращается в чей-то did', () => {
    expect(didFromPubB64('не ключ')).toBeNull();
  });
});

describe('своя переписка отделяется до всех проверок отправки', () => {
  it('sendMessage начинается с проверки своего ключа', () => {
    const body = methodBody(MESSAGING, '  async sendMessage(');
    const self = body.indexOf('this.isMyOwnKey(contactPubB64)');
    expect(self).toBeGreaterThan(-1);
    expect(body).toContain('return this.saveToSelfChat(');
    // Блокировка, часовой лимит и поиск общего ключа — всё ниже: себя не
    // блокируют, себе не считают лимит и с собой не договариваются о ключе.
    for (const later of ['rateLimiter.isBlocked', 'canSendMessage', 'sendMessageWork']) {
      expect(body.indexOf(later)).toBeGreaterThan(self);
    }
  });

  it('NO_SESSION_DM живёт только в отправке собеседнику', () => {
    expect(methodBody(MESSAGING, '  async sendMessage(')).not.toContain('NO_SESSION_DM');
    expect(methodBody(MESSAGING, '  private async saveToSelfChat(')).not.toContain('NO_SESSION_DM');
    expect(methodBody(MESSAGING, '  private async sendMessageWork(')).toContain('NO_SESSION_DM');
  });
});

describe('saveToSelfChat пишет в базу и никуда не отправляет', () => {
  const body = methodBody(MESSAGING, '  private async saveToSelfChat(');

  it('ни конверта, ни транспорта, ни шифрования', () => {
    for (const network of [
      'multiTransportRouter',
      'publishMessageWithRetry',
      'publishToSelfInbox',
      'encryptSymmetric',
      'announceCid',
      'getSymmetricKeyForPeer',
    ]) {
      expect(body).not.toContain(network);
    }
  });

  it('строка ложится доставленной, с местной ссылкой вместо CID', () => {
    expect(body).toContain('await upsertChatMessage(');
    expect(body).toContain("status: 'delivered'");
    expect(body).toContain('cid: `local:${ts}`');
    expect(body).toContain('void touchConversation(');
  });

  it('служебный конверт и живая метка в заметки не попадают', () => {
    expect(body).toContain('if (isControlOnlyText(text) || isLiveLocMessage(text))');
    expect(body.indexOf('return null;')).toBeLessThan(body.indexOf('await upsertChatMessage('));
  });

  it('вложения проходят обычную загрузку — местный путь в переписке не рисуется', () => {
    expect(body).toContain('this.uploadMediaFromUri(uri, myDid)');
    expect(body).toContain('decideMediaSend(tallyMediaUploads(results))');
  });
});

describe('экран переписки не рассказывает о себе самому себе', () => {
  it('профиль и время последнего входа при входе в «Избранное» не уходят', () => {
    const start = CHAT_SCREEN.indexOf('void syncLastSeenPrefTo(peerB64);');
    expect(start).toBeGreaterThan(-1);
    const effect = CHAT_SCREEN.slice(CHAT_SCREEN.lastIndexOf('useEffect(', start), start);
    expect(effect).toContain('if (isSavedMessages) return;');
    // Условие эффекта должно знать про признак, иначе он не пересчитается
    // при переходе из чужой переписки в свою.
    const tail = CHAT_SCREEN.slice(start, start + 600);
    expect(tail).toContain('}, [peerB64, isSavedMessages]);');
  });
});
