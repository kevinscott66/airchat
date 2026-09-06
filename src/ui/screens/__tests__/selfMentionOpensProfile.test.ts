/**
 * v4.32.609: нажатие на СВОЁ имя обязано куда-то вести.
 *
 * До этой версии `@своё_имя` в переписке и в группе упиралось в проверку
 * «это же я» и молча возвращалось — экран не менялся, подсказки не было, и
 * отличить это от поломки нельзя. Чужое имя открывает карточку человека,
 * значит своё должно открывать собственный профиль.
 *
 * Проверки структурные: отрисовать эти экраны в тесте нельзя — они тянут
 * SQLite, криптографию и половину нативных модулей. А регрессия тихая:
 * молчаливый `return` вернётся одной строкой, всё соберётся и пройдёт.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const screen = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');
const app = () => readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf8');

/** Тело функции `handleMentionPress` — от объявления до закрывающего `}, [`. */
function mentionHandler(src: string): string {
  const start = src.indexOf('const handleMentionPress');
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf('}, [', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, src.indexOf(');', end));
}

describe('своё упоминание ведёт в собственный профиль', () => {
  it('переписка: своё имя зовёт onOpenOwnProfile, а не выходит молча', () => {
    const body = mentionHandler(screen('ChatScreen.tsx'));
    expect(body).toContain('if (hit.peerPubB64 === myPubB64) { onOpenOwnProfile?.(); return; }');
    expect(body).not.toContain('if (hit.peerPubB64 === myPubB64) return;');
    expect(body).toContain('onOpenOwnProfile]');
  });

  it('группа: и участник, и найденный в реестре ведут в свой профиль', () => {
    const body = mentionHandler(screen('GroupsScreen.tsx'));
    expect(body).toContain('if (hit.peerPubB64 === myPubB64) { onOpenOwnProfile?.(); return; }');
    expect(body).toContain('if (hits[0].peerPubB64 === myPubB64) { onOpenOwnProfile?.(); return; }');
    expect(body).not.toMatch(/=== myPubB64\) return;/);
    expect(body).toContain('onOpenOwnProfile]');
  });

  it('лента: своё имя не открывает карточку самого себя', () => {
    const body = mentionHandler(screen('FeedScreen.tsx'));
    expect(body).toContain('if (hit.peerPubB64 === myPubB64) { onOpenOwnProfile?.(); return; }');
    // Проверка стоит ДО открытия карточки — иначе она успеет показаться.
    expect(body.indexOf('=== myPubB64')).toBeLessThan(body.indexOf('setPeekAuthorPub('));
  });
});

describe('App отдаёт всем трём экранам один и тот же переход', () => {
  const src = app();

  it('переход существует и ведёт именно в таб профиля', () => {
    const start = src.indexOf('const handleOpenOwnProfile');
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf('}, [', start));
    expect(body).toContain("mountTab('profile')");
    expect(body).toContain("setTab('profile')");
  });

  it('проп доходит до ленты, переписки и групп', () => {
    expect(src.match(/onOpenOwnProfile=\{handleOpenOwnProfile\}/g) ?? []).toHaveLength(3);
  });
});
