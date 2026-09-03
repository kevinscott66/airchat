/**
 * Рэтчет v4.32.571: у полноэкранной модалки шапка не уезжает под часы.
 *
 * Что ломалось. В карточке профиля пункт «Файлы» открывает
 * ChatSharedMediaModal — <Modal animationType="slide"> без
 * presentationStyle, то есть окно на весь экран, включая строку состояния.
 * Внутри сразу шёл обычный <View>, и шапка со стрелкой «назад» и заголовком
 * ложилась под часы и батарею: на телефоне с вырезом нажимать «назад» было
 * нечем. Ровно та же беда была у общих медиа группы и у публикаций профиля.
 *
 * Проверяем исходник: такие модалки обязаны открываться SafeScreen с верхней
 * вставкой — тем же, что у полноэкранных модалок контактов (v4.32.42).
 * Модалок этого вида ровно три, они перечислены поимённо: список без имён
 * пришлось бы угадывать по разметке, а угаданный рэтчет ловит не то.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const FULL_SCREEN = [
  ['modals', 'chat', 'ChatSharedMediaModal.tsx'],
  ['modals', 'groups', 'GroupSharedMediaModal.tsx'],
  ['modals', 'profile', 'ProfilePostsModal.tsx'],
];

describe('полноэкранные модалки живут в безопасной зоне', () => {
  for (const parts of FULL_SCREEN) {
    const name = parts[parts.length - 1];
    it(`${name} — шапка не под строкой состояния`, () => {
      const src = readFileSync(join(__dirname, '..', 'components', ...parts), 'utf8');
      // Окно действительно во весь экран: без presentationStyle и не прозрачное.
      expect(src).toContain('<Modal visible={visible} animationType="slide"');
      expect(src).not.toContain('presentationStyle=');
      // И сразу за ним — вставка сверху.
      const modalIdx = src.indexOf('<Modal visible={visible} animationType="slide"');
      const after = src.slice(modalIdx, modalIdx + 700);
      expect(after).toContain("<SafeScreen edges={['top', 'left', 'right']}");
      expect(src).toContain('SafeScreen');
    });
  }
});
