/**
 * v4.32.889 — дорожка голосового показывала место, где звука нет.
 *
 * Дефект. Нажатие по полосе сначала двигало цифры (`setPositionMs(seekMs)`),
 * и только потом просило проигрыватель перемотать. Отказ гасился пустым
 * `.catch(() => {})`: ни возврата, ни следа в журнале. Тем же пустым ловцом
 * гасилась перемотка к началу после конца записи — та самая, ради которой её
 * и добавляли.
 *
 * Цена. Пока голосовое на паузе, событий статуса не приходит, и поправить
 * дорожку некому: полоса и часы стоят там, куда нажали, а звук — где был.
 * Следующее «играть» продолжает совсем с другого места. Человек видит, что
 * нажатие сработало, и слышит обратное — а разбираться потом не по чему.
 *
 * Правка. Место, о котором отчитался сам проигрыватель, запоминается
 * (`playedMsRef`); отказ перемотки возвращает дорожку туда и называет причину
 * в журнал. Удачная перемотка это место обновляет — иначе возврат целился бы
 * в устаревшее.
 */
import fs from 'fs';
import path from 'path';

/** Исходник без строк-комментариев: объяснение правки не должно её подтверждать. */
function code(rel: string): string {
  return fs
    .readFileSync(path.join(__dirname, '..', rel), 'utf8')
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

const VOICE = (): string => code('VoiceMessage.tsx');
const seek = (): string => between(VOICE(), 'const seekTo = useCallback(', '}, [sound, totalMs]);');

describe('отказ перемотки не оставляет дорожку соврамши', () => {
  it('пустого ловца в перемотке больше нет', () => {
    expect(seek()).not.toContain('.catch(() => {})');
  });

  it('дорожка возвращается туда, где звук на самом деле', () => {
    const s = seek();
    const moved = s.indexOf('setPositionMs(seekMs);');
    const failed = s.indexOf('} catch (e) {');
    const back = s.indexOf('setPositionMs(playedMsRef.current);');
    expect(moved).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(moved);
    expect(back).toBeGreaterThan(failed);
  });

  it('причина уходит в журнал подлинником', () => {
    expect(seek()).toContain("log.warn('voice_seek_failed', { err: rawErrorText(e) });");
  });

  it('удачная перемотка обновляет запомненное место', () => {
    const s = seek();
    const done = s.indexOf('await sound.seekTo(seekMs / 1000);');
    const remember = s.indexOf('playedMsRef.current = seekMs;');
    expect(done).toBeGreaterThan(-1);
    expect(remember).toBeGreaterThan(done);
  });

  it('запомненное место ведёт сам проигрыватель, а не наши догадки', () => {
    const listener = between(VOICE(), "snd.addListener('playbackStatusUpdate'", '});\n  }, []);');
    expect(listener).toContain('playedMsRef.current = status.currentTime * 1000;');
    expect(listener).toContain('playedMsRef.current = 0;');
  });

  it('перемотка «куда нажали до первого играть» тоже больше не молчит', () => {
    const toggle = between(VOICE(), 'const togglePlayback = useCallback(', 'const seekTo = useCallback(');
    expect(toggle).toContain("log.warn('voice_start_seek_failed', { err: rawErrorText(e) })");
  });

  it('перемотка к началу после конца записи тоже больше не молчит', () => {
    const finish = between(VOICE(), 'if (status.didJustFinish) {', '}, []);');
    expect(finish).toContain("log.warn('voice_rewind_failed', { err: rawErrorText(e) })");
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ: цифры по-прежнему двигаются раньше звука', () => {
  it('нажатие сразу переносит дорожку — иначе возвращать было бы нечего', () => {
    const s = seek();
    expect(s).toContain('const seekMs = Math.round(ratio * totalMs);');
    expect(s.indexOf('setPositionMs(seekMs);')).toBeLessThan(s.indexOf('await sound.seekTo('));
  });

  it('на паузе статус не приходит: поправить дорожку может только этот ловец', () => {
    const listener = between(VOICE(), "snd.addListener('playbackStatusUpdate'", '});\n  }, []);');
    expect(listener).toContain('if (!status.isLoaded) return;');
    expect(listener).toContain('setPositionMs(status.currentTime * 1000);');
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: перемотка осталась перемоткой', () => {
  it('место нажатия по-прежнему считается от ширины полосы', () => {
    const s = seek();
    expect(s).toContain('if (progressWidth.current === 0 || totalMs === 0) return;');
    expect(s).toContain('e.nativeEvent.locationX / progressWidth.current');
  });

  it('перемотка до первого «играть» по-прежнему запоминается', () => {
    expect(seek()).toContain('pendingSeekMsRef.current = seekMs;');
  });

  it('конец записи по-прежнему возвращает проигрыватель к началу', () => {
    const finish = between(VOICE(), 'if (status.didJustFinish) {', '}, []);');
    expect(finish).toContain('snd.seekTo(0)');
    expect(finish).toContain('setPlaying(false);');
  });
});
