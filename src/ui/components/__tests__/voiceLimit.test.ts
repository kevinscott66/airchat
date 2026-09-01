/**
 * У голосового появилась верхняя граница (v4.32.562).
 *
 * Дефект. Кнопка микрофона писала ровно столько, сколько человек держал палец,
 * а вложение обрезано жёстко: uploadEncryptedBlob отказывается от файла больше
 * MAX_BLOB_BYTES. При пресете 128 кбит/с порог приходится примерно на восемь с
 * третью минут. Дальше приложение читало многомегабайтный файл в память,
 * шифровало его, получало от загрузки null — и показывало «Голосовое не
 * загрузилось. Проверьте соединение и повторите.» Соединение было ни при чём:
 * такое сообщение не ушло бы ни с какой попытки, а текст звал повторить. Сама
 * запись при этом стиралась, то есть девять минут речи пропадали вместе с
 * ложным объяснением.
 *
 * Рэтчет держит три вещи: границу и запас под ней (иначе её однажды поднимут
 * до самого порога вложения), окончание записи ОТПРАВКОЙ, а не выбрасыванием,
 * и то, что отказ по размеру называется своим именем.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  shouldAutoStopVoice,
  voiceCountdownSeconds,
  voiceRemainingMs,
  voiceUploadRefusal,
  VOICE_COUNTDOWN_MS,
  VOICE_MAX_MS,
  VOICE_MIN_MS,
} from '../voiceLimit';
import { MAX_BLOB_BYTES } from '../../../core/media/blobRef';

/** Байт в секунду при пресете записи HIGH_QUALITY (128 кбит/с). */
const BYTES_PER_SEC = 128_000 / 8;

function read(...rel: string[]): string {
  return fs.readFileSync(path.join(__dirname, '..', ...rel), 'utf8');
}
const RECORDER = () => read('VoiceMessage.tsx');
const CHAT = () => read('..', 'screens', 'ChatScreen.tsx');
const GROUPS = () => read('..', 'screens', 'GroupsScreen.tsx');

describe('граница и запас под ней', () => {
  it('пять минут, а не «сколько влезет»', () => {
    expect(VOICE_MAX_MS).toBe(300_000);
    expect(VOICE_COUNTDOWN_MS).toBe(30_000);
    expect(VOICE_MIN_MS).toBe(500);
  });

  it('запись целиком помещается во вложение, и с запасом', () => {
    const worstCase = (VOICE_MAX_MS / 1000) * BYTES_PER_SEC;
    expect(worstCase).toBeLessThan(MAX_BLOB_BYTES);
    // Не «влезает впритык»: битрейт — цель кодека, а не гарантия.
    expect(worstCase).toBeLessThan(MAX_BLOB_BYTES * 0.75);
  });

  it('обратный отсчёт успевает показаться до конца записи', () => {
    expect(VOICE_COUNTDOWN_MS).toBeGreaterThan(0);
    expect(VOICE_COUNTDOWN_MS).toBeLessThan(VOICE_MAX_MS);
  });
});

describe('остаток времени', () => {
  it('в начале записи остаток равен всей границе', () => {
    expect(voiceRemainingMs(0)).toBe(VOICE_MAX_MS);
  });

  it('уменьшается ровно на прошедшее', () => {
    expect(voiceRemainingMs(60_000)).toBe(VOICE_MAX_MS - 60_000);
  });

  it('за границей — ноль, а не отрицательное число', () => {
    expect(voiceRemainingMs(VOICE_MAX_MS + 5_000)).toBe(0);
  });

  it('сломанный таймер не превращается в отрицательный остаток', () => {
    expect(voiceRemainingMs(Number.NaN)).toBe(VOICE_MAX_MS);
    expect(voiceRemainingMs(-1)).toBe(VOICE_MAX_MS);
  });
});

describe('запись заканчивает себя сама', () => {
  it('до границы — не заканчивает', () => {
    expect(shouldAutoStopVoice(0)).toBe(false);
    expect(shouldAutoStopVoice(VOICE_MAX_MS - 1)).toBe(false);
  });

  it('на границе и за ней — заканчивает', () => {
    expect(shouldAutoStopVoice(VOICE_MAX_MS)).toBe(true);
    expect(shouldAutoStopVoice(VOICE_MAX_MS + 60_000)).toBe(true);
  });

  it('нечисло не обрывает запись на первой же секунде', () => {
    expect(shouldAutoStopVoice(Number.NaN)).toBe(false);
    expect(shouldAutoStopVoice(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('обратный отсчёт', () => {
  it('молчит, пока до границы далеко', () => {
    expect(voiceCountdownSeconds(0)).toBeNull();
    expect(voiceCountdownSeconds(VOICE_MAX_MS - VOICE_COUNTDOWN_MS - 1)).toBeNull();
  });

  it('появляется ровно за полминуты до конца', () => {
    expect(voiceCountdownSeconds(VOICE_MAX_MS - VOICE_COUNTDOWN_MS)).toBe(30);
  });

  it('округляет вверх — у идущей записи не бывает нуля секунд', () => {
    expect(voiceCountdownSeconds(VOICE_MAX_MS - 200)).toBe(1);
  });

  it('на самой границе показывает ноль', () => {
    expect(voiceCountdownSeconds(VOICE_MAX_MS)).toBe(0);
  });
});

describe('отказ по размеру называется своим именем', () => {
  it('обычный файл проходит', () => {
    expect(voiceUploadRefusal(100_000, MAX_BLOB_BYTES)).toBeNull();
    expect(voiceUploadRefusal(MAX_BLOB_BYTES, MAX_BLOB_BYTES)).toBeNull();
  });

  it('слишком большой файл не зовут повторить попытку', () => {
    const text = voiceUploadRefusal(MAX_BLOB_BYTES + 1, MAX_BLOB_BYTES);
    expect(text).toContain('слишком длинное');
    expect(text).not.toContain('соединение');
    expect(text).not.toContain('овторите');
  });

  it('пустой файл — это не «нет сети», а неудавшаяся запись', () => {
    expect(voiceUploadRefusal(0, MAX_BLOB_BYTES)).toContain('Запись не получилась');
  });

  it('неизвестный размер решает не здесь', () => {
    expect(voiceUploadRefusal(null, MAX_BLOB_BYTES)).toBeNull();
    expect(voiceUploadRefusal(Number.NaN, MAX_BLOB_BYTES)).toBeNull();
  });
});

describe('форма исходников', () => {
  it('таймер записи спрашивает границу, а не сравнивает число сам', () => {
    const src = RECORDER();
    expect(src).toContain("from './voiceLimit'");
    expect(src).toContain('if (shouldAutoStopVoice(ms)) stopSelfRef.current?.();');
  });

  it('дойдя до границы, запись отправляется, а не выбрасывается', () => {
    const src = RECORDER();
    // Окончание по таймеру идёт тем же путём, что и отпускание пальца, —
    // значит через stopRecording, который вызывает onRecorded.
    expect(src).toContain('stopSelfRef.current = () => { void stopRecording(); };');
    expect(src).toContain('if (uri && durationMs > VOICE_MIN_MS) {');
    expect(src).toContain('onRecorded({ uri, durationMs });');
  });

  it('минимальная длительность больше не набрана числом на месте', () => {
    expect(RECORDER()).not.toContain('durationMs > 500');
  });

  it('обратный отсчёт виден на кнопке', () => {
    const src = RECORDER();
    expect(src).toContain('const countdown = voiceCountdownSeconds(recDurationMs);');
    expect(src).toContain('{countdown === null ? formatClockDuration(recDurationMs)');
  });

  it('оба экрана проверяют размер до загрузки', () => {
    for (const src of [CHAT(), GROUPS()]) {
      expect(src).toContain("import { voiceUploadRefusal } from '../components/voiceLimit';");
      expect(src).toContain('voiceUploadRefusal(await fileSizeBytes(');
      expect(src).toContain('if (tooBig) throw new Error(tooBig);');
    }
  });

  it('проверка стоит РАНЬШЕ загрузки, а не после неё', () => {
    for (const src of [CHAT(), GROUPS()]) {
      expect(src.indexOf('if (tooBig) throw new Error(tooBig);'))
        .toBeLessThan(src.indexOf("uploadEncryptedBlob(r"));
    }
  });
});
