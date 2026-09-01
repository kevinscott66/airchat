/**
 * Своё название и описание группы против чужих (v4.32.379).
 *
 * Смысл модуля в том, что правило ОДНО. Поэтому проверяется не только сама
 * чистка, но и совпадение: то, что даёт normalizeOwnGroupName своей строке,
 * обязано совпасть с тем, что даст той же строке разбор чужого конверта.
 * Разойдись они — и вернётся ровно та поломка, ради которой модуль написан:
 * у автора группа называется одним, у всех остальных другим.
 */
import {
  FALLBACK_GROUP_NAME,
  OWN_GROUP_DESC_MAX,
  OWN_GROUP_NAME_MAX,
  normalizeOwnGroupDescription,
  normalizeOwnGroupName,
} from '../groupNameRule';
import { GROUP_CTL_PREFIX, decodeGroupCtlEnvelope } from '../groupControlEnvelope';

const wire = (over: Record<string, unknown>): Record<string, unknown> | null =>
  decodeGroupCtlEnvelope(
    GROUP_CTL_PREFIX + JSON.stringify({ groupId: 'g1', ts: 1_700_000_000_000, op: 'meta', ...over })
  ) as Record<string, unknown> | null;

describe('название своей группы', () => {
  it('перевод строки становится пробелом, а не исчезает', () => {
    // Название уходит в системную строку подстановкой («Группа переименована в
    // «X»»), и перевод строки внутри него дописывает к ней вторую строку.
    expect(normalizeOwnGroupName('Наши\u2028Вы заблокированы')).toBe('Наши Вы заблокированы');
    expect(normalizeOwnGroupName('Наши\nребята')).toBe('Наши ребята');
  });

  it('метки направления письма вырезаются', () => {
    expect(normalizeOwnGroupName('Клуб\u202Eexe.pdf')).toBe('Клубexe.pdf');
  });

  it('название, от которого ничего не остаётся, — это отсутствие названия', () => {
    // Ровно его редактор и обязан отвергнуть: разбор приглашения и разбор
    // ссылки такое название не принимают, и группа не заводится ни у кого.
    for (const n of ['', '   ', '\u200D', '\u2800\u2800', '\u3164']) {
      expect([JSON.stringify(n), normalizeOwnGroupName(n)]).toEqual([JSON.stringify(n), '']);
    }
    expect(normalizeOwnGroupName(42)).toBe('');
    expect(normalizeOwnGroupName(null)).toBe('');
  });

  it('длина мерится своим числом, и оно то же, что на приёме', () => {
    expect(normalizeOwnGroupName('я'.repeat(400))).toHaveLength(OWN_GROUP_NAME_MAX);
    expect(wire({ name: 'я'.repeat(400) })?.name).toHaveLength(OWN_GROUP_NAME_MAX);
  });

  it('своё правило и чужое дают один результат', () => {
    for (const n of ['Наши\u2028ребята', 'Клуб\u202Eexe.pdf', '  Отдел  ', 'А\u0007Б', 'я'.repeat(300)]) {
      expect([n, wire({ name: n })?.name]).toEqual([n, normalizeOwnGroupName(n)]);
    }
  });

  it('расходятся они ровно в одном месте, и это намеренно', () => {
    // Пустой результат своё правило отдаёт вызывающему как есть — редактор
    // обязан отказаться сохранять. Конверт в этом случае теряет поле целиком:
    // «переименовать в ничто» — не операция, и применять там нечего.
    expect(normalizeOwnGroupName('‍')).toBe('');
    expect('name' in (wire({ name: '‍' }) as object)).toBe(false);
  });

  it('запасное название непустое: иначе им нечего подставлять', () => {
    expect(normalizeOwnGroupName(FALLBACK_GROUP_NAME)).toBe(FALLBACK_GROUP_NAME);
  });
});

describe('описание своей группы', () => {
  it('абзацы остаются, пустых строк подряд — не больше одной', () => {
    // Описание рисуется обычным <Text> в карточке группы: 512 переводов строки
    // растягивают её на весь экран.
    expect(normalizeOwnGroupDescription('Про нас.\n\nПишем код.')).toBe('Про нас.\n\nПишем код.');
    expect(normalizeOwnGroupDescription('верх' + '\n'.repeat(400) + 'низ')).toBe('верх\n\nниз');
  });

  it('метки направления письма вырезаются и здесь', () => {
    expect(normalizeOwnGroupDescription('отчет\u202Eexe.pdf')).toBe('отчетexe.pdf');
  });

  it('пустое описание законно — это «описания нет»', () => {
    expect(normalizeOwnGroupDescription('   ')).toBe('');
    expect(normalizeOwnGroupDescription('\u200D')).toBe('');
    expect(normalizeOwnGroupDescription(undefined)).toBe('');
  });

  it('длина мерится своим числом, и оно то же, что на приёме', () => {
    const long = 'б'.repeat(2000);
    expect(normalizeOwnGroupDescription(long)).toHaveLength(OWN_GROUP_DESC_MAX);
    expect(wire({ description: long })?.description).toHaveLength(OWN_GROUP_DESC_MAX);
  });

  it('своё правило и чужое дают один результат', () => {
    for (const d of ['Про нас.\n\nПишем код.', 'верх\n\n\n\nниз', 'отчет\u202Eexe.pdf', '   ']) {
      expect([d, wire({ description: d })?.description]).toEqual([d, normalizeOwnGroupDescription(d)]);
    }
  });
});
