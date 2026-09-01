/**
 * Что автор узнаёт о судьбе своей сторис (v4.32.360).
 *
 * Сторис пишется в базу до рассылки, и автор видит её у себя всегда — с
 * картинкой, с текстом, с полным ощущением, что всё получилось. Всё, что
 * отличает «опубликовано» от «лежит на телефоне», — это одна фраза отсюда.
 */

import { storyPublishProblem, type StoryPublishOutcome } from '../storyPublishOutcome';

const ok = (over: Partial<StoryPublishOutcome> = {}): StoryPublishOutcome => ({
  mediaFailure: null,
  contacts: 3,
  delivered: 3,
  ...over,
});

describe('storyPublishProblem', () => {
  it('всё дошло — молчит', () => {
    expect(storyPublishProblem(ok(), 'image')).toBeNull();
    expect(storyPublishProblem(ok(), 'video')).toBeNull();
  });

  it('нет контактов — не жалуется на нулевую доставку', () => {
    // Ноль из нуля — это не сбой, а первый день в приложении.
    expect(storyPublishProblem(ok({ contacts: 0, delivered: 0 }), 'image')).toBeNull();
  });

  it('часть контактов не получила — не тревожит зря', () => {
    // Один офлайн-контакт из трёх — обычное дело, сторис живёт сутки.
    expect(storyPublishProblem(ok({ contacts: 3, delivered: 1 }), 'image')).toBeNull();
  });

  it('никто не получил — говорит именно это', () => {
    const msg = storyPublishProblem(ok({ contacts: 3, delivered: 0 }), 'image');
    expect(msg).toContain('не ушла ни одному контакту');
  });

  it('несостоявшаяся рассылка важнее разговора о медиа', () => {
    // «Сторис ушла без видео», когда она вообще никуда не ушла, — ложь в
    // главном ради подробности.
    const msg = storyPublishProblem(
      ok({ contacts: 2, delivered: 0, mediaFailure: { reason: 'oversize', limitBytes: 8_000_000 } }),
      'video'
    );
    expect(msg).toContain('не ушла ни одному контакту');
    expect(msg).not.toContain('больше');
  });

  describe('медиа не уехало', () => {
    it('превышен предел — называет тот предел, по которому и отказали', () => {
      // Прежний экран говорил «предел 8 МБ» всегда; при включённом IPFS для
      // видео он другой, и названный вслух предел был просто неверным.
      expect(storyPublishProblem(ok({ mediaFailure: { reason: 'oversize', limitBytes: 25_000_000 } }), 'video'))
        .toBe('Видео больше 25 МБ — сторис ушла без него');
      expect(storyPublishProblem(ok({ mediaFailure: { reason: 'oversize', limitBytes: 8_000_000 } }), 'image'))
        .toBe('Изображение больше 8 МБ — сторис ушла без него');
    });

    it('сорвавшаяся загрузка не выдаётся за превышение размера', () => {
      // Иначе автор удаляет и пересжимает видео, которое подошло бы и так.
      const msg = storyPublishProblem(ok({ mediaFailure: { reason: 'failed', limitBytes: 8_000_000 } }), 'video');
      expect(msg).toBe('Видео не загрузилось — сторис ушла без него');
      expect(msg).not.toContain('МБ');
    });

    it('род существительного совпадает с видом медиа', () => {
      expect(storyPublishProblem(ok({ mediaFailure: { reason: 'failed', limitBytes: 8_000_000 } }), 'image'))
        .toBe('Изображение не загрузилось — сторис ушла без него');
    });
  });
});
