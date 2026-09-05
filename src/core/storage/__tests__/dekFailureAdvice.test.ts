/**
 * Отказ «данные не открываются»: что показать и что предложить (v4.32.603).
 *
 * Проверяется главное различие, ради которого модуль и написан: сброс
 * предлагается только там, где терять уже нечего, и НЕ предлагается там, где
 * хранилище просто не отвечает. Ошибка во второй половине стоит переписки:
 * человек нажимает единственную кнопку на экране и стирает целые данные из-за
 * временного сбоя.
 */
import { DEK_FAILURE_PREFIX, dekFailureAdvice } from '../dekFailureAdvice';
import { decideDek } from '../dekPolicy';
import { DekUnavailableError } from '../localEncryption';

/** Сообщение так, как его увидит экран: через настоящую ошибку. */
const msg = (reason: string): string => new DekUnavailableError(reason).message;

describe('dekFailureAdvice', () => {
  it('разбирает ровно тот текст, который строит DekUnavailableError', () => {
    // Иначе разбор разъедется с источником молча: экран покажет латиницу, а
    // тесты останутся зелёными.
    expect(msg('key_lost_data_present')).toBe(`${DEK_FAILURE_PREFIX}key_lost_data_present`);
    expect(dekFailureAdvice(msg('key_lost_data_present'))).not.toBeNull();
  });

  it('чужую ошибку не трогает', () => {
    expect(dekFailureAdvice('database is locked')).toBeNull();
    expect(dekFailureAdvice('')).toBeNull();
  });

  it('после выхода из учётной записи объясняет и предлагает начать заново', () => {
    // Тот самый экран: вышли из учётной записи, зашли снова — и приложение не
    // открывается. Раньше здесь стояла строка `key_lost_data_present`.
    const a = dekFailureAdvice(msg('key_lost_data_present'));

    expect(a?.resettable).toBe(true);
    expect(a?.text).toMatch(/секретн[а-я]+ слов/i);
    expect(a?.text).not.toContain('key_lost');
  });

  it('«хранилище не отвечает» сбросом не лечится', () => {
    for (const reason of ['key_unreadable', 'key_and_canary_unreadable', 'seed_unreadable']) {
      expect([reason, dekFailureAdvice(msg(reason))?.resettable]).toEqual([reason, false]);
    }
  });

  it('незнакомая причина сброс не предлагает', () => {
    // Необратимое удаление вслепую — худшее, что можно сделать с непонятной
    // ошибкой.
    const a = dekFailureAdvice(msg('reason_from_the_future'));

    expect(a?.resettable).toBe(false);
    expect(a?.text.length).toBeGreaterThan(0);
  });

  it('ни один отказ политики не остаётся без человеческого текста', () => {
    // Список причин берётся у самой политики перебором наблюдений, а не
    // переписывается сюда: новая ветка REFUSE должна ронять этот тест, а не
    // тихо доезжать до экрана латиницей.
    const states = ['valid', 'absent', 'malformed', 'unreadable'] as const;
    const canaries = ['present', 'absent', 'unreadable'] as const;
    const mnemonics = ['present', 'absent', 'unreadable'] as const;
    const tri = [true, false, null];
    const refusals = new Set<string>();
    for (const stored of states) {
      for (const canary of canaries) {
        for (const mnemonic of mnemonics) {
          for (const storedOpensCanary of tri) {
            for (const derivedOpensCanary of tri) {
              const d = decideDek({ stored, canary, storedOpensCanary, mnemonic, derivedOpensCanary });
              if (d.action === 'refuse') refusals.add(d.reason);
            }
          }
        }
      }
    }

    expect(refusals.size).toBeGreaterThanOrEqual(4);
    for (const reason of refusals) {
      expect([reason, dekFailureAdvice(msg(reason)) !== null]).toEqual([reason, true]);
    }
  });
});
