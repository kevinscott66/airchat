/**
 * v4.32.569: «Запрет копирования и пересылки» — обещание, данное словами в
 * карточке профиля. Обещание держат не переменные, а конкретные места экрана
 * переписки: пока пункт «Переслать» или выгрузка чата не спрятаны за флагом,
 * настройка врёт, а увидеть это в отзыве можно только вручную.
 *
 * Проверяем исходник, а не поведение: экран целиком в тесте не поднять, зато
 * пропажу условия видно сразу и она стоит одну строку.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const chat = readFileSync(join(__dirname, '..', 'screens', 'ChatScreen.tsx'), 'utf8');
const quick = readFileSync(
  join(__dirname, '..', 'components', 'modals', 'chat', 'ChatQuickReactModal.tsx'),
  'utf8'
);

describe('запрет копирования закрывает и пересылку', () => {
  it('пункт «Переслать» в меню сообщения на iOS выдаётся только без запрета', () => {
    const rows = chat
      .split('\n')
      .filter((l) => l.includes("'Переслать'") && l.includes('copyBlockedRef.current'));
    // Два меню: своё сообщение и чужое.
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toContain("? [] : ['Переслать']");
  });

  it('меню сообщения на Android прячет «Переслать» под тем же флагом', () => {
    expect(quick).toContain('{!isMedia && !copyBlocked ? (');
    const forwardIdx = quick.indexOf('label="Переслать"');
    expect(forwardIdx).toBeGreaterThan(0);
    const before = quick.slice(0, forwardIdx);
    expect(before.slice(before.lastIndexOf('{!isMedia'))).toContain('!copyBlocked');
  });

  it('панель выделения прячет и «Переслать», и «Копировать»', () => {
    // Обе кнопки панели закрыты одним и тем же условием.
    expect(chat.split('{copyBlocked ? null : (').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('лента сообщений едет под защищённый слой только при запрете', () => {
    // Обёртка выбирается по флагу: без этого переписка пропадала бы со
    // снимков и в тех чатах, где запрет не включали.
    expect(chat).toContain('const MessagesShell = copyBlocked && secureShellAvailable ? SecureContent : View;');
    expect(chat).toContain('<MessagesShell style={{ flex: 1 }}>');
    expect(chat).toContain('</MessagesShell>');
  });

  it('выгрузка переписки уходит вместе с копированием', () => {
    expect(chat).toContain("...(copyBlocked ? [] : [");
    const exportIdx = chat.indexOf("text: 'Экспорт чата'");
    expect(exportIdx).toBeGreaterThan(0);
    const before = chat.slice(0, exportIdx);
    expect(before.slice(-400)).toContain('copyBlocked ? [] : [');
  });
});
