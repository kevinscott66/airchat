/**
 * Голосовое: таймер идёт, а своё отправленное видно (v4.32.722).
 *
 * 1. Уборка эффекта на [sound] срабатывала и при переходе `null → плеер` и
 *    снимала подписку на статус, которую новый плеер только что завёл. Таймер
 *    и дорожка стояли на месте с первого нажатия, конец записи не ловился.
 * 2. Голосовое и GIF, в отличие от текста, не прокручивали ленту к своему
 *    пузырю — из прокрученной вверх переписки он уезжал за экран.
 */
import * as fs from 'fs';
import * as path from 'path';

function code(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

test('уборка плеера не снимает подписку, пока плеера ещё не было', () => {
  const src = code('components/VoiceMessage.tsx');
  const cleanup = between(src, 'useEffect(() => {\n    return () => {', '}, [sound]);');
  const guard = cleanup.indexOf('if (!sound) return;');
  const unsub = cleanup.indexOf('subRef.current.remove()');
  expect(guard).toBeGreaterThan(-1);
  expect(unsub).toBeGreaterThan(guard);
});

test('отправка голосового и GIF прокручивает ленту к своему пузырю', () => {
  const src = code('screens/ChatScreen.tsx');
  const voice = between(src, 'const sendVoice = useCallback(', 'const sendGif = useCallback(');
  // Оба пути: «Избранное» и обычная переписка.
  expect(voice.match(/scrollToNewest\(\);/g)?.length).toBe(2);
  expect(voice.indexOf('scrollToNewest();', voice.indexOf('setOptimisticOutgoing({')))
    .toBeLessThan(voice.indexOf('uploadEncryptedBlob('));
  const gif = between(src, 'const sendGif = useCallback(', 'CHAT_CMDS');
  expect(gif.match(/scrollToNewest\(\);/g)?.length).toBe(2);
  // Объявлен до первого использования в зависимостях — иначе TDZ на рендере.
  expect(src.indexOf('const scrollToNewest = useCallback(')).toBeLessThan(src.indexOf('const sendVoice = useCallback('));

  const group = between(code('screens/GroupsScreen.tsx'), 'announceGroupSend(fanoutGroupMessage(group.id, voiceText', 'catch (e)');
  expect(group).toContain('scrollToOffset({ offset: 0');
});
