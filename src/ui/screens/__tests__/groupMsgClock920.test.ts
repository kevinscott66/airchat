/**
 * Под сообщением группы стояло «5 мин» вместо «15:45» (v4.32.920).
 *
 * Дефект. Экран групп импортировал подпись времени под чужим именем:
 *
 *     import { formatListTime as formatTime, formatSearchTime } from '../time/listTime';
 *
 * и звал `formatTime` в двух совершенно разных местах — в строке СПИСКА групп
 * (по `lastMessageAt`) и под каждым СООБЩЕНИЕМ в открытой группе (по
 * `createdAt`). Для списка это верно: строка отвечает «когда сюда в последний
 * раз писали», и «только что», «5 мин», «вчера», «пт» там на месте. Под
 * сообщением та же функция отвечает не на тот вопрос.
 *
 * Цена. Время суток у сообщения пропадает почти всегда. `formatListTime`
 * возвращает час (`clockTime`) ровно в одном случае — сообщение сегодняшнее и
 * старше часа. В остальных вместо «15:45» стоит «только что», «5 мин»,
 * «вчера», «пт» или «12 мар»:
 *   • Вчерашнее сообщение подписано «вчера» — а над ним уже висит разделитель
 *     дня (`injectGrpDateSeparators`), который говорит ровно то же самое.
 *     Дата написана дважды, часа нет ни разу.
 *   • Подпись живая: одно и то же сообщение по мере хода времени называется
 *     «только что», потом «5 мин», потом «15:45», потом «вчера», потом «пт».
 *     Вернуться в группу и найти сообщение по времени нельзя.
 *   • В личной переписке всё это время правильно: `ChatScreen` зовёт
 *     `clockTime` (v4.32.421 развёл список и переписку, а группы остались на
 *     списочной подписи). Два экрана одного приложения, два разных ответа на
 *     один вопрос.
 * Обойти можно было только долгим нажатием — оно показывает `fullDateTime`.
 *
 * Правка. Под сообщением — `clockTime`, как в личной переписке. Строка списка
 * групп остаётся на `formatListTime`, и псевдоним `formatTime`, из-за которого
 * два разных смысла выглядели одним, убран.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { clockTime } from '../../../core/time/ruDateTime';
import { formatListTime } from '../../time/listTime';

const SRC = readFileSync(join(__dirname, '..', 'GroupsScreen.tsx'), 'utf8');
const CHAT = readFileSync(join(__dirname, '..', 'ChatScreen.tsx'), 'utf8');

/** Строки кода без комментариев — чтобы пояснение не выдавало себя за вызов. */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const CODE = codeOnly(SRC);

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники прочитались и обе подписи в них есть', () => {
    expect(CODE.length).toBeGreaterThan(50_000);
    expect(CODE).toContain('formatListTime');
    expect(CHAT).toContain('clockTime(item.createdAt)');
  });

  it('две подписи и правда отвечают по-разному', () => {
    // Повод для правки не выдуман: у сегодняшнего часового они расходятся.
    const now = new Date(2026, 8, 25, 15, 45).getTime();
    const fiveMinAgo = now - 5 * 60_000;
    expect(formatListTime(fiveMinAgo, now)).toBe('5 мин');
    expect(clockTime(fiveMinAgo)).toBe('15:40');
  });
});

describe('под сообщением стоит час', () => {
  it('подпись сообщения берётся у clockTime', () => {
    expect(CODE).toContain("{item.editedAt ? 'изм. ' : ''}{clockTime(item.createdAt)}");
  });

  it('списочной подписи под сообщением больше нет', () => {
    expect(CODE).not.toContain('formatListTime(item.createdAt)');
    expect(CODE).not.toContain('formatTime(item.createdAt)');
  });

  it('псевдонима, под которым два смысла выглядели одним, не осталось', () => {
    expect(CODE).not.toContain('formatListTime as formatTime');
    expect(CODE).not.toContain('formatTime(');
    // Строка списка зовёт ту же подпись, но теперь под её настоящим именем.
    expect(CODE).toContain('formatListTime(item.lastMessageAt)');
  });

  it('группы отвечают тем же, чем личная переписка', () => {
    // Один вопрос — один ответ на обоих экранах.
    expect(CODE).toContain('clockTime(item.createdAt)');
    expect(CHAT).toContain('clockTime(item.createdAt)');
  });

  it('час не зависит от того, когда на него смотрят', () => {
    const ts = new Date(2026, 8, 20, 9, 5).getTime();
    expect(clockTime(ts)).toBe('09:05');
    // Через неделю — та же подпись, а списочная успела смениться дважды.
    const later = ts + 7 * 24 * 3_600_000;
    expect(clockTime(ts)).toBe('09:05');
    expect(formatListTime(ts, later)).not.toBe('09:05');
  });
});

describe('до правки было верно и осталось верно', () => {
  it('строка списка групп по-прежнему на списочной подписи', () => {
    // Про имя эта проверка нарочно не спрашивает — до правки та же самая
    // функция звалась здесь `formatTime`. Стоит она ради того, что правка
    // трогать не должна: строку списка по-прежнему подписывает списочное
    // время, и берётся оно по-прежнему у `lastMessageAt`.
    expect(CODE).toMatch(/\bformat(List)?Time\(item\.lastMessageAt\)/);
  });

  it('строка глобального поиска не тронута', () => {
    expect(CODE).toContain('formatSearchTime(r.message.createdAt)');
  });

  it('долгое нажатие по-прежнему показывает дату целиком', () => {
    expect(CODE).toContain("Alert.alert('', fullDateTime(item.createdAt))");
  });

  it('разделители дня над сообщениями остались', () => {
    expect(CODE).toContain('injectGrpDateSeparators(messages, grpOpenUnread)');
  });

  it('списочная подпись сама по себе не менялась', () => {
    const now = new Date(2026, 8, 25, 15, 45).getTime();
    expect(formatListTime(now - 30_000, now)).toBe('только что');
    expect(formatListTime(now - 5 * 60_000, now)).toBe('5 мин');
    expect(formatListTime(new Date(2026, 8, 24, 10, 0).getTime(), now)).toBe('вчера');
  });
});
