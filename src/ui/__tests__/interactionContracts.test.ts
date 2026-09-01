import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('UI interaction contracts', () => {
  const chat = read('src/ui/screens/ChatScreen.tsx');
  const groups = read('src/ui/screens/GroupsScreen.tsx');
  const voice = read('src/ui/components/VoiceMessage.tsx');

  it('keeps one keyboard host on the two main composer screens', () => {
    expect(chat).not.toContain('KeyboardAvoidingView');
    expect(groups).not.toContain('KeyboardAvoidingView');
    expect(chat).toContain('<KeyboardHost>');
    expect(groups).toContain('<KeyboardHost>');
  });

  it('limits both composers to the shared message length', () => {
    expect(chat).toContain('maxLength={MAX_MESSAGE_TEXT}');
    expect(groups).toContain('maxLength={MAX_MESSAGE_TEXT}');
  });

  it('gives primary icon-only actions accessible names', () => {
    for (const label of [
      'Отправить сообщение',
      'Прикрепить файл',
      'Быстрые ответы',
      'Назад к чатам',
    ]) {
      expect(chat).toContain(`accessibilityLabel="${label}"`);
    }
    expect(chat).toContain("accessibilityLabel={showEmojiPanel ? 'Показать клавиатуру' : 'Открыть эмодзи'}");
    for (const label of [
      'Создать группу или канал',
      'Отметить все группы прочитанными',
      'Прикрепить файл',
      'Отправить сообщение',
      'Быстрые ответы',
    ]) {
      expect(groups).toContain(`accessibilityLabel="${label}"`);
    }
    expect(groups).toContain("accessibilityLabel={grpEmojiPanelVisible ? 'Показать клавиатуру' : 'Открыть эмодзи'}");
    expect(voice).toContain('Записать голосовое сообщение');
    expect(voice).toContain('Остановить запись голосового сообщения');
  });

  it('keeps bootstrap and loading surfaces tied to theme tokens', () => {
    const entrypoint = read('index.ts');
    const loading = read('src/ui/screens/LoadingScreen.tsx');
    expect(entrypoint).toContain('darkColors.background');
    expect(entrypoint).not.toContain("backgroundColor: '#0b1020'");
    expect(loading).toContain('accessibilityRole="progressbar"');
    expect(loading).toContain('themeColors.background');
  });

  it('keeps the crash fallback consistent with the Russian UI', () => {
    const boundary = read('src/ui/AppErrorBoundary.tsx');
    expect(boundary).toContain('Произошла ошибка');
    expect(boundary).toContain('Перезапустите приложение');
    expect(boundary).not.toContain('Something went wrong');
    expect(boundary).not.toContain('Try again');
  });
});
