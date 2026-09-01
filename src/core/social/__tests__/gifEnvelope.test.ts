/**
 * GIF от чужого клиента.
 *
 * До v4.32.240 разбор был `text.slice(PREFIX.length)`, и адрес уезжал прямо в
 * <Image>. Достаточно было прислать ссылку на свой сервер, чтобы устройство
 * получателя само на него сходило при открытии переписки: IP-адрес, провайдер
 * и точное время прочтения — без единого действия получателя и в обход
 * отключённых отметок о прочтении.
 */

import { GIF_PREFIX, isGifMessage, makeGifText, parseGifUrl } from '../gifEnvelope';

const TENOR = 'https://media1.tenor.com/m/AbC123xyz/happy-cat.gif';

describe('parseGifUrl', () => {
  it('round-trip адреса Tenor', () => {
    const t = makeGifText(TENOR);
    expect(isGifMessage(t)).toBe(true);
    expect(parseGifUrl(t)).toBe(TENOR);
  });

  it('поддомены Tenor и сам tenor.com проходят', () => {
    for (const u of [
      'https://media.tenor.com/x/a.gif',
      'https://media1.tenor.com/m/x/a.gif',
      'https://c.tenor.com/x/a.gif',
      'https://tenor.com/view/a-1234',
      'https://MEDIA.TENOR.COM/x/a.gif',
    ]) {
      expect(parseGifUrl(makeGifText(u))).toBe(u);
    }
  });

  it('не GIF — null', () => {
    for (const t of ['', 'привет', '\x01voice:{}', GIF_PREFIX]) expect(parseGifUrl(t)).toBeNull();
  });

  it('чужой хост не грузится — это и есть слив IP', () => {
    for (const u of [
      'https://zlo.example/t.gif?id=victim',
      'https://tracker.example/pixel',
      'http://media.tenor.com/x/a.gif',
    ]) {
      expect(parseGifUrl(makeGifText(u))).toBeNull();
    }
  });

  it('хост, притворяющийся Tenor, не проходит', () => {
    for (const u of [
      'https://tenor.com.zlo.example/a.gif',
      'https://tenor.com@zlo.example/a.gif',
      'https://media.tenor.com.zlo.example/a.gif',
      'https://nottenor.com/a.gif',
      'https://tenor.com',
    ]) {
      expect(parseGifUrl(makeGifText(u))).toBeNull();
    }
  });

  it('нехттп-схемы отсекаются', () => {
    for (const u of [
      'file:///etc/passwd',
      'data:image/gif;base64,R0lGOD',
      'content://media/external/images/1',
      'javascript:alert(1)',
      '//media.tenor.com/x/a.gif',
    ]) {
      expect(parseGifUrl(makeGifText(u))).toBeNull();
    }
  });

  it('пробелы и переводы строк в адресе не проходят', () => {
    expect(parseGifUrl(makeGifText('https://media.tenor.com/x/a.gif\nhttps://zlo.example'))).toBeNull();
    expect(parseGifUrl(makeGifText('https://media.tenor.com/ x/a.gif'))).toBeNull();
  });

  it('адрес длиннее 512 символов отбрасывается', () => {
    expect(parseGifUrl(makeGifText(`https://media.tenor.com/${'a'.repeat(600)}.gif`))).toBeNull();
  });
});
