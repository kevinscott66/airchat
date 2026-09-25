/**
 * Запланированное сообщение звалось двумя словами, а время — в двух формах
 * (v4.32.913).
 *
 * Дефект первый. Список зовётся «Запланированные», вопрос перед удалением —
 * «Удалить запланированное сообщение?», а отказ, который приходит ПРЯМО НА
 * ЭТОТ вопрос, говорил «Не удалось удалить отложенное сообщение» — и в
 * переписке, и в группе. «Отложенное» это слово из кода (`scheduled` там же
 * зовут отложенным в комментариях); на экране его нет больше нигде.
 *
 * Дефект второй. Одно и то же — «когда уйдёт» — записано тремя формами:
 *
 *     переписка, подтверждение: fullDateTime  → «25 сентября 2026, 14:30:00»
 *     группа, подтверждение:    (молчит)      → «Сообщение запланировано»
 *     список, строка:           dayMonthShortTime → «25 сен, 14:30»
 *
 * Цена. В группе выбранное время не называлось вовсе: проверить, правильно ли
 * поняли минуту, можно было только открыв список отдельной кнопкой. В
 * переписке оно называлось с секундами — точность, которой человек не задавал
 * (выбор идёт минутами), и при этом не совпадающая со строкой в списке, куда
 * он пойдёт смотреть. Три записи одного момента человек сверяет глазами.
 *
 * Правка. Слово одно — «запланированное». Форма времени одна — та, которой
 * подписана строка в списке.
 *
 * Экраны в jest не поднимаются (весь react-native внутри), поэтому места
 * вызова проверяются по исходнику — как в storyBlankName906.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { dayMonthShortTime, fullDateTime } from '../../core/time/ruDateTime';

const UI = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(UI, rel), 'utf8');

/** Исходник без комментариев: пояснение к правке цитирует прежние надписи. */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

const SCREENS = ['screens/ChatScreen.tsx', 'screens/GroupsScreen.tsx'];

/** 25 сентября 2026, 14:30 по местному времени. */
const SEND_AT = new Date(2026, 8, 25, 14, 30, 0, 0).getTime();

describe('сообщение зовут запланированным, а время пишут как в списке', () => {
  test('отказ удаления называет сообщение так же, как вопрос перед ним', () => {
    for (const rel of SCREENS) {
      const code = codeOnly(read(rel));
      expect(code).toContain("'Не удалось удалить запланированное сообщение'");
      expect(code).not.toContain('Не удалось удалить отложенное сообщение');
    }
  });

  test('«отложенн» не осталось ни в одной надписи обоих экранов', () => {
    // Комментарии сняты: в коде слово живёт законно (отложенная запись
    // черновика, отложенный таймер) — запрещено оно только на экране.
    for (const rel of SCREENS) {
      const offenders = codeOnly(read(rel))
        .split('\n')
        .filter((l) => /отложенн/i.test(l));
      expect(offenders).toEqual([]);
    }
  });

  test('группа называет выбранное время, а не молчит о нём', () => {
    const code = codeOnly(read('screens/GroupsScreen.tsx'));
    expect(code).toContain('showSuccess(`Запланировано на ${dayMonthShortTime(sendAt)}`);');
    expect(code).not.toContain("showSuccess('Сообщение запланировано');");
  });

  test('переписка пишет ту же форму, что и группа', () => {
    const code = codeOnly(read('screens/ChatScreen.tsx'));
    expect(code).toContain('showSuccess(`Запланировано на ${dayMonthShortTime(sendAt)}`);');
    expect(code).not.toContain('Запланировано на ${fullDateTime(sendAt)}');
  });
});

describe('до правки было верно и осталось верно', () => {
  test('форма, на которую перешли, — та, которой подписана строка списка', () => {
    // Она была такой и до правки: менялись подтверждения, а не список.
    const inList = codeOnly(read('components/modals/shared/ScheduledListModal.tsx'));
    expect(inList).toContain('{dayMonthShortTime(item.sendAt)}');
    expect(dayMonthShortTime(SEND_AT)).toBe('25 сен, 14:30');
  });

  test('прежняя форма обещала секунды, которых человек не выбирал', () => {
    // Цена дефекта, зафиксированная значением: выбор идёт минутами.
    expect(fullDateTime(SEND_AT)).toBe('25 сентября 2026, 14:30:00');
    expect(fullDateTime(SEND_AT)).not.toBe(dayMonthShortTime(SEND_AT));
  });

  test('fullDateTime остался там, где секунды и год нужны', () => {
    // Сведения о сообщении и выгрузка — форма судебная, её не трогали.
    for (const rel of SCREENS) {
      expect(codeOnly(read(rel))).toContain('fullDateTime(item.createdAt)');
      expect(codeOnly(read(rel))).toContain('fullDateTime(m.createdAt)');
    }
  });

  test('список и вопрос перед удалением звали сообщение запланированным и раньше', () => {
    const modal = codeOnly(read('components/modals/shared/ScheduledListModal.tsx'));
    expect(modal).toContain('>Запланированные</Text>');
    expect(modal).toContain("'Удалить запланированное сообщение?'");
  });

  test('отказ планирования не трогали — он и так говорил по-человечески', () => {
    expect(codeOnly(read('screens/GroupsScreen.tsx'))).toContain(
      "userErrorText(e, 'Не удалось запланировать отправку')",
    );
  });

  test('обход исходника не пуст и комментарии из него убраны', () => {
    // Невырожденность: без этого проверки на отсутствие зелены и на пустой строке.
    for (const rel of SCREENS) expect(read(rel).length).toBeGreaterThan(10_000);
    expect(codeOnly('// отложенное сообщение\nconst a = 1;')).not.toContain('отложенн');
    expect(codeOnly("const t = 'отложенное сообщение';")).toContain('отложенн');
  });
});
