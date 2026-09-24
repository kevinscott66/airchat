/**
 * v4.32.862. Проигрыватель голосового снова мог начать играть с закрытого
 * экрана — и на этот раз уже не из-за сети.
 *
 * Дефект. В 620-й окно между «скачали вложение» и «создали плеер» закрыли
 * проверкой `mountedRef` прямо перед созданием: пока шла сеть, экран успевал
 * закрыться, а уборка завязана на `[sound]` и видит только то, что легло в
 * состояние. В 722-й перед укладкой в состояние появилось второе ожидание —
 * `await snd.seekTo(...)`, перемотка «туда, куда нажали до первого играть».
 * Проверка осталась там же, где была, то есть ДО него, и окно открылось
 * заново: плеер уже создан, `setSound` после размонтирования не делает
 * ничего, уборка о нём не узнаёт никогда.
 *
 * Цена. Запись играет вслух с экрана, которого нет, — остановить её нечем.
 * Хуже того, покойник занимает `activeVoicePlayer`, поэтому следующее
 * голосовое честно «останавливает» его вместо того, что звучит, и звук идёт
 * в два голоса. Освободить память тоже некому.
 *
 * Правка. Ожидание кончается той же проверкой, и в этой ветке плеер убирают
 * руками — подписку снять, `remove()`, выйти. Правило здесь не «есть строка
 * такая-то», а «каждое ожидание между созданием и укладкой в состояние
 * кончается проверкой»: третье ожидание, добавленное завтра, обязано её
 * повторить.
 *
 * Проверяется исходник: expo-audio в jest не поднимается, а суть правки — в
 * порядке шагов, а не в значении.
 */
import * as fs from 'fs';
import * as path from 'path';

const VOICE_PATH = path.join(__dirname, '..', 'VoiceMessage.tsx');

/** Код без комментариев: пояснение не должно подменять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const VOICE = (): string => codeOnly(fs.readFileSync(VOICE_PATH, 'utf8'));

function slice(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  expect(a).toBeGreaterThan(0);
  const b = src.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

/** От создания плеера до первого звука — участок, где его ещё никто не уберёт. */
const window = (): string => slice(VOICE(), 'const snd = createAudioPlayer(', 'snd.play();');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходник читается и это тот самый плеер', () => {
    expect(VOICE().length).toBeGreaterThan(2000);
    expect(VOICE()).toContain('export function VoicePlayer(');
    expect(window().length).toBeGreaterThan(100);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('уборка по-прежнему знает только то, что легло в состояние', () => {
    const cleanup = slice(VOICE(), 'return () => {\n      if (!sound) return;', '}, [sound]);');
    expect(cleanup).toContain('sound?.remove();');
    expect(VOICE()).toContain('}, [sound]);');
  });

  it('признак живого экрана — тот же ref, что и в 620-й', () => {
    expect(VOICE()).toContain('useEffect(() => () => { mountedRef.current = false; }, []);');
  });

  it('проверка перед созданием осталась на месте: её не подменяют, а дополняют', () => {
    const before = slice(VOICE(), 'await setAudioModeAsync(', 'const snd = createAudioPlayer(');
    expect(before).toContain('if (!mountedRef.current) return;');
  });

  it('перемотка «до первого играть» никуда не делась — из-за неё и открылось окно', () => {
    expect(window()).toContain('await snd.seekTo(startMs / 1000)');
    expect(VOICE()).toContain('const pendingSeekMsRef = useRef(0);');
  });
});

describe('ни одно ожидание не оставляет плеер без хозяина', () => {
  it('каждое ожидание между созданием и состоянием кончается проверкой экрана', () => {
    const body = window();
    const awaits = [...body.matchAll(/await /g)].map((m) => m.index ?? 0);
    expect(awaits.length).toBeGreaterThan(0);
    for (const at of awaits) {
      const tail = body.slice(at, at + 400);
      expect(tail).toContain('if (!mountedRef.current) {');
    }
  });

  it('проверка стоит между последним ожиданием и укладкой в состояние', () => {
    const body = window();
    const guard = body.indexOf('if (!mountedRef.current) {');
    const lastAwait = body.lastIndexOf('await ');
    const put = body.indexOf('setSound(snd);');
    expect(lastAwait).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(lastAwait);
    expect(put).toBeGreaterThan(guard);
  });

  it('в этой ветке плеер убирают руками: состояние его уже не примет', () => {
    const guard = slice(window(), 'if (!mountedRef.current) {', 'setSound(snd);');
    expect(guard).toContain('subRef.current.remove();');
    expect(guard).toContain('subRef.current = null;');
    expect(guard).toContain('snd.remove();');
    expect(guard).toContain('return;');
  });

  it('до проверки плеер никому не отдан: ни общему месту, ни звуку', () => {
    const body = window();
    const guard = body.indexOf('if (!mountedRef.current) {');
    const head = body.slice(0, guard);
    expect(head).not.toContain('activeVoicePlayer = {');
    expect(head).not.toContain('setPlaying(true);');
    expect(head).not.toContain('setSound(');
  });
});

describe('живой экран ничего не потерял', () => {
  it('после проверки идёт всё то же, что и раньше', () => {
    const tail = slice(VOICE(), 'setSound(snd);', 'snd.play();');
    expect(tail).toContain('activeVoicePlayer = { player: snd, stop: () => setPlaying(false) };');
    expect(tail).toContain('setPlaying(true);');
  });

  it('скорость и подписка ставятся до ожидания — их проверка не отменяет', () => {
    const head = slice(VOICE(), 'const snd = createAudioPlayer(', 'await snd.seekTo(');
    expect(head).toContain('attachStatusListener(snd);');
    expect(head).toContain('snd.setPlaybackRate(speed);');
  });
});
