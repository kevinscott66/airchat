/**
 * Личное сообщение будит телефон, а не только группа (v4.32.477).
 *
 * Уведомление о переписке показывалось ровно в одном месте — в обработчике
 * входящего FCM. Сообщение, доехавшее по локальной сети, через ретранслятор
 * или через IPFS, не показывало ничего: экран не загорался, в шторке не
 * появлялось строки, и узнать о сообщении можно было, только открыв
 * приложение. У групп ветка «показать уведомление на приёме» есть с самого
 * начала — у личных переписок её не было, притом что push в этой сборке
 * зависит от чужого сервера и работает не всегда.
 *
 * Заодно закрыты два соседних следствия того же места: одно сообщение,
 * доехавшее двумя путями, считалось дважды (счётчик непрочитанного и плашка),
 * а превью для списка чатов считалось по СЫРОМУ тексту — то есть собеседник,
 * приславший текст с префиксом системной строки, показывал в списке строку от
 * имени приложения, хотя в базу она ложилась уже очищенной.
 */
import * as fs from 'fs';
import * as path from 'path';

import { previewLabelForText } from '../../core/social/messagePreview';
import { stripSpoofedSysPrefix, SYS_LINE_PREFIX } from '../../core/social/sysLineGuard';
import {
  DM_BANNER_BODY_MAX,
  DM_BANNER_FALLBACK_BODY,
  DM_BANNER_FALLBACK_TITLE,
  dmBannerText,
} from '../dmBannerText';

const SRC = path.join(__dirname, '..', '..');
const PUSH = fs.readFileSync(path.join(__dirname, '..', 'pushNotifications.ts'), 'utf8');
const MESSAGING = fs.readFileSync(path.join(SRC, 'core', 'social', 'messaging.ts'), 'utf8');

describe('текст уведомления о личном сообщении', () => {
  it('превью включено и текст известен — показываем имя и текст', () => {
    expect(dmBannerText({ senderName: 'Аня', preview: 'привет', showPreview: true })).toEqual({
      title: 'Аня',
      body: 'привет',
    });
  });

  it('превью выключено — ни имени, ни текста', () => {
    expect(dmBannerText({ senderName: 'Аня', preview: 'привет', showPreview: false })).toEqual({
      title: DM_BANNER_FALLBACK_TITLE,
      body: DM_BANNER_FALLBACK_BODY,
    });
  });

  it('текста нет (пришло по push) — общая фраза вместо пустой строки', () => {
    expect(dmBannerText({ senderName: 'Аня', showPreview: true }).body).toBe(DM_BANNER_FALLBACK_BODY);
  });

  it('текст из одних пробелов на экране блокировки — то же самое', () => {
    expect(dmBannerText({ senderName: 'Аня', preview: '   ', showPreview: true }).body).toBe(
      DM_BANNER_FALLBACK_BODY
    );
  });

  it('собеседника нет в контактах — заголовок общий, а не пустой', () => {
    expect(dmBannerText({ senderName: '', preview: 'привет', showPreview: true }).title).toBe(
      DM_BANNER_FALLBACK_TITLE
    );
  });

  it('длинное сообщение не уезжает в шторку целиком', () => {
    const long = 'я'.repeat(DM_BANNER_BODY_MAX + 50);
    expect(dmBannerText({ senderName: 'Аня', preview: long, showPreview: true }).body.length).toBe(
      DM_BANNER_BODY_MAX
    );
  });
});

describe('превью не даёт выдать чужой текст за системную строку', () => {
  const spoof = `${SYS_LINE_PREFIX}Исчезающие сообщения включены`;

  it('сырой текст собеседника прочитался бы как системная строка', () => {
    expect(previewLabelForText(spoof)).toBe('Исчезающие сообщения включены');
  });

  it('а сохранённый — как обычное сообщение, с видимым префиксом', () => {
    const stored = stripSpoofedSysPrefix(spoof);
    expect(previewLabelForText(stored)).toBe('Исчезающие сообщения включены');
    expect(stored.startsWith(SYS_LINE_PREFIX)).toBe(false);
  });

  it('приём считает превью по сохранённому тексту, а не по сырому', () => {
    expect(MESSAGING).toContain('const previewText = previewLabelForText(row.text).slice(0, 120);');
    expect(MESSAGING).not.toContain('previewLabelForText(textPayload.text ?? \'\').slice(0, 120)');
  });
});

describe('приём личного сообщения показывает системное уведомление', () => {
  it('push-слой подписан на входящие сообщения, а не только на FCM', () => {
    expect(PUSH).toContain('subscribeInAppNotifications');
    expect(PUSH).toContain('this.unsubDmNotify = subscribeInAppNotifications(');
  });

  it('показ общий для обоих путей', () => {
    expect(PUSH).toContain('private async showDmBanner(');
    const calls = PUSH.match(/this\.showDmBanner\(/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it('подписка снимается при смене профиля — иначе баннеры удвоятся', () => {
    expect(PUSH).toContain('try { this.unsubDmNotify?.(); } catch { /* best effort */ }');
    expect(PUSH).toContain('this.unsubDmNotify = null;');
  });

  it('прежние проверки на месте: открытый чат, «не беспокоить», mute, выключатель', () => {
    const at = PUSH.indexOf('private async showDmBanner(');
    const body = PUSH.slice(at, at + 4000);
    // v4.32.525: «открытый чат» теперь решает activeChatSuppress — совпадения
    // одного лишь собеседника мало, нужны ещё активная вкладка и передний план.
    expect(body).toContain('shouldSuppressDmBanner(openScreenState(), contactDid)');
    expect(body).toContain('await isDndActive()');
    expect(body).toContain("isMuted('chat', contactDid)");
    expect(body).toContain("kvGet('notify_dm')");
    // v4.32.571: тот же учёт, но бронью — reserve вместо has+mark.
    expect(body).toContain('!notifyDedup.reserve(cid)');
  });

  it('имя берётся только из своей базы контактов', () => {
    const at = PUSH.indexOf('private async showDmBanner(');
    const body = PUSH.slice(at, at + 4000);
    expect(body).toContain('await listContacts()');
    expect(body).toContain('sanitizeDisplayName(match.displayName, 80)');
  });

  it('событие приёма несёт ключ сообщения и DID отправителя', () => {
    expect(MESSAGING).toContain('  /** Ключ сообщения: CID из IPFS либо `lan:<id>` для прямой доставки. */');
    expect(MESSAGING).toContain('          cid,\n          senderDid: em.senderDid,');
  });
});

describe('одно сообщение — одно уведомление', () => {
  it('приём спрашивает базу до записи, была ли уже такая строка', () => {
    expect(MESSAGING).toContain(
      'const alreadyStored = (await getChatMessageAuthor(rowId, ownerPid)) != null;'
    );
  });

  it('повтор не двигает счётчик непрочитанного и не показывает плашку', () => {
    const at = MESSAGING.indexOf('const alreadyStored =');
    const body = MESSAGING.slice(at, at + 1600);
    expect(body).toContain('if (!alreadyStored) {\n      void touchConversation(');
    expect(body).toContain('if (!alreadyStored) {\n        log.info(\'dm_incoming_saved\'');
  });

  it('push и приём разводятся по одному и тому же cid', () => {
    expect(PUSH).toContain('notifyDedup.reserve(cid)');
    expect(PUSH).toContain('await this.showDmBanner({ cid, contactDid });');
  });
});

describe('проверка не пустая', () => {
  it('у групп такая ветка есть — с неё и списана', () => {
    expect(PUSH).toContain('setGroupMessageNotifyCallback(');
  });

  it('модуль текста уведомления существует и экспортирует свои пределы', () => {
    expect(typeof dmBannerText).toBe('function');
    expect(DM_BANNER_BODY_MAX).toBeGreaterThan(0);
  });
});
