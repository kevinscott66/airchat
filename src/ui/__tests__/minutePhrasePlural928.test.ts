/**
 * Минуты во фразе склоняются, как и всё остальное (v4.32.928).
 *
 * Дефект: число минут печаталось обрубком «мин» там, где рядом стоит глагол и
 * человек читает строку целиком. Четыре места, и в двух из них соседнее число
 * в ТОЙ ЖЕ функции уже склонялось:
 *
 *   - `lastSeenLabel`: «был(а) 20 мин назад» — и строкой ниже «был(а) 3 часа
 *     назад» через `ruPlural`. Проверка на этот счёт в доме была, называлась
 *     «минуты и часы склоняются» и закрепляла «20 мин»;
 *   - `liveLocDetail`: «ещё 12 мин» и «последняя точка 5 мин назад» — при том
 *     что соседняя ветка того же выражения пишет «ещё меньше минуты» словом;
 *   - `showPasswordRejected`: «Повторите через 5 мин» — про ту же самую
 *     блокировку, о которой экран блокировки говорит «Попробуйте через
 *     5 минут»;
 *   - подпись просмотра в ленте: «{{n}} мин назад» из словаря.
 *
 * Цена: «5 мин» — не ошибка, а недоговорённость, и она стоит ровно там, где
 * приложение сообщает факт о другом человеке или о собственном запрете. Сразу
 * за ней в двух случаях идёт правильно склонённое «3 часа», и разнобой внутри
 * одной строки читается как небрежность именно в этом факте. Хуже другое: про
 * одну и ту же блокировку приложение говорило двумя разными фразами, и человек
 * упирается в обе подряд — сначала в смене пароля, потом на входе.
 *
 * Правка: формы «минуту/минуты/минут» и «час/часа/часов» переехали в
 * `core/text/ruPlural` — их зовут и ядро, и интерфейс, а ядру нельзя
 * импортировать из `ui/`. Уведомление о блокировке считает и называет минуты
 * теми же `lockoutMinutesLeft` и `minutesLabel`, что и экран блокировки.
 *
 * Границы: сокращение «мин» ОСТАВЛЕНО там, где число стоит без глагола, в
 * одном ряду с соседними единицами, — значение настройки («10 сек», «5 мин»,
 * «1 ч»), столбик времени в списке чатов, длительность записи. Это правило
 * дом уже сформулировал в v4.32.912 для секунд; здесь оно только применено к
 * минутам и ниже закреплено, чтобы следующая уборка не «дочинила» вслепую.
 */
import fs from 'fs';
import path from 'path';

import { lastSeenLabel } from '../../core/time/lastSeenLabel';
import { liveLocDetail } from '../../core/social/liveLocFreshness';
import { formatSlowMode } from '../../core/social/groupSendPolicy';
import { formatListTime } from '../time/listTime';
import { hoursLabel, minutesLabel } from '../utils/plural';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('{/*');
    })
    .join('\n');

const ru = JSON.parse(read('i18n/ru.json')) as { feed: { time: Record<string, string> } };

const MIN = 60_000;
const NOW = new Date(2026, 8, 25, 12, 0, 0, 0).getTime();

/** Все файлы исходников, кроме тестов: где ещё лежит список форм. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__') sources(p, out);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

describe('минуты во фразе называются словом', () => {
  it('«был(а) N минут назад» — во всех трёх формах', () => {
    expect(lastSeenLabel(NOW - 20 * MIN, NOW).label).toBe('был(а) 20 минут назад');
    expect(lastSeenLabel(NOW - 21 * MIN, NOW).label).toBe('был(а) 21 минуту назад');
    expect(lastSeenLabel(NOW - 22 * MIN, NOW).label).toBe('был(а) 22 минуты назад');
    expect(lastSeenLabel(NOW - 11 * MIN, NOW).label).toBe('был(а) 11 минут назад');
  });

  it('часы в той же подписи не тронуты', () => {
    expect(lastSeenLabel(NOW - 3 * 3_600_000, NOW).label).toBe('был(а) 3 часа назад');
    expect(lastSeenLabel(NOW - 9 * 3_600_000, NOW).label).toBe('был(а) 9 часов назад');
  });

  it('пузырь живой геолокации: и остаток, и возраст точки', () => {
    expect(liveLocDetail({ expireAt: NOW + 12 * MIN, now: NOW, updatedAt: NOW })).toBe('ещё 12 минут');
    expect(liveLocDetail({ expireAt: NOW + 2 * MIN, now: NOW, updatedAt: NOW })).toBe('ещё 2 минуты');
    expect(liveLocDetail({ expireAt: NOW + 90_000, now: NOW, updatedAt: NOW })).toBe('ещё 1 минуту');
    expect(liveLocDetail({ expireAt: NOW + 60 * MIN, now: NOW, updatedAt: NOW - 5 * MIN })).toBe(
      'последняя точка 5 минут назад'
    );
    expect(liveLocDetail({ expireAt: NOW + 60 * MIN, now: NOW, updatedAt: NOW - 2 * MIN })).toBe(
      'последняя точка 2 минуты назад'
    );
    expect(liveLocDetail({ expireAt: NOW + 60 * MIN, now: NOW, updatedAt: NOW - 100_000 })).toBe(
      'последняя точка 1 минуту назад'
    );
  });

  it('подписи из ui/utils/plural дают три формы', () => {
    expect(minutesLabel(1)).toBe('1 минуту');
    expect(minutesLabel(3)).toBe('3 минуты');
    expect(minutesLabel(15)).toBe('15 минут');
    expect(hoursLabel(1)).toBe('1 час');
    expect(hoursLabel(4)).toBe('4 часа');
    expect(hoursLabel(11)).toBe('11 часов');
  });
});

describe('одна блокировка — одна фраза', () => {
  it('уведомление считает и называет минуты теми же помощниками, что экран', () => {
    const feedback = codeOnly('ui/components/userFeedback.ts');
    expect(feedback).not.toContain('Повторите через');
    expect(feedback).not.toContain('Math.ceil(waitMs / 60_000)');
    expect(feedback).toContain(
      'Слишком много попыток. Попробуйте через ${minutesLabel(lockoutMinutesLeft(waitMs))}'
    );

    const screen = codeOnly('ui/screens/PasswordScreen.tsx');
    expect(screen).toContain('Слишком много попыток. Попробуйте через ${minutesLabel(lockoutMinutesLeft(lockout))}');
  });
});

describe('подпись просмотра в ленте приходит уже склонённой', () => {
  it('словарь держит рамку, а слово подставляет код', () => {
    expect(ru.feed.time.minAgo).toBe('{{label}} назад');
    expect(ru.feed.time.hrAgo).toBe('{{label}} назад · {{time}}');
    for (const k of ['minAgo', 'hrAgo']) expect(ru.feed.time[k]).not.toContain('{{n}}');

    const feed = codeOnly('ui/screens/FeedScreen.tsx');
    expect(feed).toContain("t('feed.time.minAgo', { label: minutesLabel(min) })");
    expect(feed).toContain("t('feed.time.hrAgo', { label: hoursLabel(hr), time })");
  });
});

describe('список форм в доме один', () => {
  it('«минуту/минуты/минут» написано ровно в одном файле исходников', () => {
    const forms = "'минуту', 'минуты', 'минут'";
    const holders = sources(SRC).filter((p) => fs.readFileSync(p, 'utf8').includes(forms));
    expect(holders.map((p) => path.relative(SRC, p))).toEqual(['core/text/ruPlural.ts']);
  });

  it('обрубка не осталось ни в одной из тронутых подписей', () => {
    for (const rel of ['core/time/lastSeenLabel.ts', 'core/social/liveLocFreshness.ts']) {
      // Ровно две формы, в которых обрубок здесь стоял: «${mins} мин назад»
      // и «ещё ${mins} мин». Полное слово подставляет вызов, а не подстановка.
      expect(codeOnly(rel)).not.toContain('мин назад');
      expect(codeOnly(rel)).not.toContain('} мин');
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: сокращение при ЗНАЧЕНИИ оставлено намеренно', () => {
  it('значение медленного режима: число без глагола, в ряду с соседними единицами', () => {
    expect(formatSlowMode(30)).toBe('30 сек');
    expect(formatSlowMode(5 * 60)).toBe('5 мин');
    expect(formatSlowMode(2 * 3600)).toBe('2 ч');
  });

  it('столбик времени в списке чатов тоже: там нет фразы, только число', () => {
    expect(formatListTime(NOW - 5 * MIN, NOW)).toBe('5 мин');
    expect(formatListTime(NOW - 30_000, NOW)).toBe('только что');
  });

  it('ветки «меньше минуты» и «недавно» остались словами, как и были', () => {
    expect(liveLocDetail({ expireAt: NOW + 30_000, now: NOW, updatedAt: NOW })).toBe('ещё меньше минуты');
    // Парной ей ветки «последняя точка меньше минуты назад» здесь нет
    // намеренно: она недостижима. «Замерла» объявляется после трёх тактов
    // молчания, то есть не раньше полутора минут, а «меньше минуты» требует
    // молчания короче минуты. Это надо знать тому, кто будет убираться
    // здесь следующим.
    expect(lastSeenLabel(NOW - 3 * MIN, NOW).label).toBe('недавно');
    expect(lastSeenLabel(NOW - 30_000, NOW).label).toBe('в сети');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('без склонения число и слово расходятся — вот как именно', () => {
    expect(`${21} минут`).not.toBe(minutesLabel(21));
    expect(`${2} минут`).not.toBe(minutesLabel(2));
    // А вот у часа винительный совпадает с именительным, и потому часы
    // склонялись верно даже там, где падеж никто не выбирал.
    expect(lastSeenLabel(NOW - 3_600_000, NOW).label).toBe('был(а) 1 час назад');
  });
});
