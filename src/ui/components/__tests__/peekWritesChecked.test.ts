/**
 * Карточка профиля не показывает сделанным то, что не записалось (v4.32.724).
 *
 * Все четыре действия карточки — заблокировать, разблокировать, пожаловаться,
 * выключить уведомления — стоят на функциях, которые отвечают отказом
 * *значением* и ничего не бросают: rateLimiter.blockContact/unblockContact,
 * setConversationMuted/setConversationMutedUntil, muteSet/muteUnset. Карточка
 * же ловила только исключения, поэтому её `.catch` не срабатывал никогда:
 * человек видел зелёное «Заблокировано» поверх незаписанного запрета, а
 * колокольчик переключался поверх незаписанного молчания. И то и другое живёт
 * до перезапуска, после которого сообщения и звонки возвращаются.
 *
 * Карточка открывается из чата, ленты, группы и сторис — это четыре входа к
 * одному и тому же обману. Те же самые записи на других экранах результат уже
 * проверяют (ChatScreen v4.32.630, ContactsScreen, BlockedContactsList), здесь
 * закрывается последнее место.
 *
 * Проверка идёт по исходнику: обработчики сидят внутри компонента, поднять
 * который в тесте — значит поднять половину приложения. Тот же приём применён
 * в locationFailure.test.ts и по той же причине.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(path.join(__dirname, '..', 'UserProfilePeek.tsx'), 'utf8');

describe('блокировка: обещано ровно то, что записалось', () => {
  it('запрет ставится только после успешной записи', () => {
    expect(SRC).toContain('if (!ok) { showError(BLOCK_NOT_SAVED_ON); return; }');
  });

  it('снятие запрета — тоже', () => {
    expect(SRC).toContain('if (!ok) { showError(BLOCK_NOT_SAVED_OFF); return; }');
  });

  it('тексты отказа берутся из общих констант, а не сочиняются заново', () => {
    // v4.32.916: проверка ловила весь список импорта целиком и падала от
    // любого нового имени рядом — хотя стоит она ради другого. Спрашиваем то,
    // ради чего: оба текста приходят из rateLimiter, а не написаны здесь.
    const line = SRC.split('\n').find((l) => l.includes("from '../../core/security/rateLimiter'"));
    expect(line).toBeDefined();
    expect(line).toContain('BLOCK_NOT_SAVED_OFF');
    expect(line).toContain('BLOCK_NOT_SAVED_ON');
  });

  it('успех больше не объявляется в then без проверки', () => {
    expect(SRC).not.toContain(".then(() => { setBlocked(true); showSuccess('Заблокировано'); })");
    expect(SRC).not.toContain(".then(() => { setBlocked(false); showSuccess('Разблокировано'); })");
  });
});

describe('жалоба: в журнал уходит то, что вышло', () => {
  it('блокировка записывается в жалобу своим настоящим исходом', () => {
    expect(SRC).toContain('const ok = await rateLimiter.blockContact(pub);');
    expect(SRC).toContain('await recordContactReport(did, r.id, ok);');
    // Прежде здесь стояло `true` — жалоба утверждала блокировку, которой нет.
    expect(SRC).not.toContain('await recordContactReport(did, r.id, true);');
  });

  it('жалоба записывается в любом случае — это обещано человеку в диалоге', () => {
    expect(SRC).toContain('Жалоба будет записана в любом случае.');
    expect(SRC).toContain('setReported(true);');
  });

  it('о непоставленном запрете сказано', () => {
    expect(SRC).toContain('else showError(BLOCK_NOT_SAVED_ON);');
  });
});

describe('уведомления: колокольчик следует за базой', () => {
  it('выключение проверяет обе записи', () => {
    expect(SRC).toContain('const okRow = await setConversationMutedUntil(pub, activeProfileId, untilMs);');
    expect(SRC).toContain("if (!okRow || !okMute) { showError('Не удалось выключить уведомления'); return; }");
  });

  it('включение проверяет обе записи', () => {
    expect(SRC).toContain('const okRow = await setConversationMuted(pub, activeProfileId, false);');
    expect(SRC).toContain("if (!okRow || !okMute) { showError('Не удалось включить уведомления'); return; }");
  });

  it('состояние наружу уходит после проверки, а не до неё', () => {
    for (const marker of ['onMuteChanged?.(true, untilMs);', 'onMuteChanged?.(false, null);']) {
      const at = SRC.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      const guard = SRC.lastIndexOf('if (!okRow || !okMute)', at);
      expect(guard).toBeGreaterThan(-1);
      // Между защитой и оповещением не должно быть другого обработчика.
      expect(SRC.slice(guard, at)).not.toContain('useCallback');
    }
  });
});
