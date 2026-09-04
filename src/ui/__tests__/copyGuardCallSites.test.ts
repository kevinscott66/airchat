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
import { messageMenu } from '../components/modals/chat/messageMenuModel';

const chat = readFileSync(join(__dirname, '..', 'screens', 'ChatScreen.tsx'), 'utf8');
const quick = readFileSync(
  join(__dirname, '..', 'components', 'modals', 'chat', 'ChatQuickReactModal.tsx'),
  'utf8'
);

describe('запрет копирования закрывает и пересылку', () => {
  // v4.32.578: меню сообщения одно на обе платформы. Второй, системный список
  // на iOS (ActionSheetIOS) со своей копией условий убран — вместе с риском,
  // что копии разойдутся и запрет останется только в одной из них.
  it('второго меню сообщения на iOS больше нет', () => {
    expect(chat).not.toContain('ActionSheetIOS.showActionSheetWithOptions');
    expect(chat).toContain('copyBlocked={copyBlocked}');
  });

  it('состав меню не выдаёт «Переслать» и «Копировать» при запрете', () => {
    for (const isOut of [false, true]) {
      const blocked = messageMenu({ isOut, isMedia: false, copyBlocked: true, canClosePoll: false });
      const all = [...blocked.primary, ...blocked.more];
      expect(all).not.toContain('copy');
      expect(all).not.toContain('forward');
      const open = messageMenu({ isOut, isMedia: false, copyBlocked: false, canClosePoll: false });
      expect([...open.primary, ...open.more]).toEqual(expect.arrayContaining(['copy', 'forward']));
    }
  });

  it('модалка берёт состав из модели, а не из своих условий', () => {
    expect(quick).toContain("from './messageMenuModel'");
    expect(quick).toContain('copyBlocked: !!copyBlocked');
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
