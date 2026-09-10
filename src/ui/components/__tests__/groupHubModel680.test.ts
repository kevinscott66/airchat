/**
 * v4.32.680: настройки группы и канала — своё окно с разделами.
 *
 * Прежде их показывали двумя разными списками пунктов: «Настройки группы» с
 * семнадцатью строками у администратора и «Параметры чата» с восемью у
 * участника. Общие пункты стояли в обеих ветках дословной копией; заголовков
 * не было ни одного; четыре флага показывались строкой, называвшей действие
 * («Режим только для админов: вкл»), так что состояние флага было не видно.
 *
 * Проверяется поведение модели, а не форма исходника: состав по правам, порядок
 * разделов, отсутствие пустых разделов и — главное — что подпись переключателя
 * совпадает с флагом, а не переворачивает его.
 */
import fs from 'fs';
import path from 'path';

import {
  groupKindWord,
  groupSettingIds,
  groupSettingsSections,
  groupSettingsTitle,
  type GroupHubFacts,
  type GroupSettingId,
} from '../groupHubModel';

const BASE: GroupHubFacts = {
  type: 'group',
  amAdmin: false,
  muted: false,
  autoTranslate: false,
  fontSizePt: null,
  slowModeSeconds: 0,
  disappearMs: null,
  adminOnlyPosting: false,
  adminOnlyPinning: false,
  requireApproval: false,
  anonymousPosting: false,
};

const facts = (over: Partial<GroupHubFacts>): GroupHubFacts => ({ ...BASE, ...over });

/** Все строки в порядке отрисовки. */
const items = (f: GroupHubFacts) => groupSettingsSections(f).flatMap((s) => s.items);
const find = (f: GroupHubFacts, id: GroupSettingId) => items(f).find((i) => i.id === id);

describe('окно настроек группы и канала', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: у участника есть строки, у администратора их больше', () => {
    const member = groupSettingIds(facts({ amAdmin: false }));
    const admin = groupSettingIds(facts({ amAdmin: true }));
    expect(member.length).toBeGreaterThan(5);
    expect(admin.length).toBeGreaterThan(member.length);
  });

  it('заголовок называет тип переписки', () => {
    expect(groupSettingsTitle(facts({ type: 'group' }))).toBe('Настройки группы');
    expect(groupSettingsTitle(facts({ type: 'channel' }))).toBe('Настройки канала');
    expect(groupKindWord('group')).toBe('Группа');
    expect(groupKindWord('channel')).toBe('Канал');
  });

  it('разделы идут от своего к общему и дальше к необратимому', () => {
    const titles = groupSettingsSections(facts({ amAdmin: true })).map((s) => s.title);
    expect(titles).toEqual([
      'На этом устройстве',
      'Содержимое',
      'Группа',
      'Права участников',
      'Переписка целиком',
    ]);
    expect(groupSettingsSections(facts({ amAdmin: true, type: 'channel' })).map((s) => s.title))
      .toContain('Канал');
  });

  it('участнику не показывают ни общих настроек, ни необратимого', () => {
    const ids = groupSettingIds(facts({ amAdmin: false }));
    for (const id of ['slow_mode', 'invite_link', 'stats', 'export', 'clear_history',
      'admin_only_posting', 'admin_only_pinning', 'require_approval', 'anonymous_posting']) {
      expect(ids).not.toContain(id);
    }
    // Свой таймер исчезновения ему при этом доступен — и раздел у него один
    // и тот же, «На этом устройстве».
    const own = groupSettingsSections(facts({ amAdmin: false }))[0];
    expect(own.items.map((i) => i.id)).toContain('disappear');
    expect(own.note).toContain('только вы');
  });

  it('пустых разделов не бывает', () => {
    for (const f of [
      facts({ amAdmin: false }),
      facts({ amAdmin: true }),
      facts({ amAdmin: false, type: 'channel' }),
      facts({ amAdmin: true, type: 'channel' }),
    ]) {
      for (const s of groupSettingsSections(f)) expect(s.items.length).toBeGreaterThan(0);
    }
  });

  it('в канале нет ни медленного режима, ни двух флагов о своих же правах', () => {
    const ids = groupSettingIds(facts({ amAdmin: true, type: 'channel' }));
    expect(ids).not.toContain('slow_mode');
    expect(ids).not.toContain('admin_only_posting');
    expect(ids).not.toContain('admin_only_pinning');
    // Одобрение входа и скрытие имён в канале остаются осмысленными.
    expect(ids).toContain('require_approval');
    expect(ids).toContain('anonymous_posting');
    // А в группе медленный режим есть, и его значение — текущее.
    expect(find(facts({ amAdmin: true, slowModeSeconds: 30 }), 'slow_mode')?.value).toBe('30 сек');
  });

  it('переключатель показывает состояние флага, а не обратное ему', () => {
    // Это и есть исходный дефект: подпись прежнего меню у «Закреплять могут
    // все» была намеренно перевёрнута относительно флага, потому что называла
    // действие. Рядом с переключателем такая подпись читается как ложь.
    const pairs: [GroupSettingId, keyof GroupHubFacts][] = [
      ['admin_only_posting', 'adminOnlyPosting'],
      ['admin_only_pinning', 'adminOnlyPinning'],
      ['require_approval', 'requireApproval'],
      ['anonymous_posting', 'anonymousPosting'],
    ];
    for (const [id, key] of pairs) {
      for (const on of [false, true]) {
        const f = facts({ amAdmin: true, [key]: on });
        const it = find(f, id);
        expect(it).toBeDefined();
        expect(it?.toggle).toBe(on);
        // Подпись — про состояние: ни «вкл», ни «выкл» в ней нет.
        expect(it?.label).not.toMatch(/вкл|выкл/i);
        // И у переключателя не бывает правой подписи со значением.
        expect(it?.value).toBeUndefined();
      }
    }
  });

  it('обычные строки не притворяются переключателями', () => {
    for (const it of items(facts({ amAdmin: true }))) {
      const isFlag = ['auto_translate', 'admin_only_posting', 'admin_only_pinning',
        'require_approval', 'anonymous_posting'].includes(it.id);
      expect(it.toggle === undefined).toBe(!isFlag);
    }
  });

  it('значения строк берутся из фактов, а не выдумываются', () => {
    expect(find(facts({ muted: true }), 'mute')?.value).toBe('Выключены');
    expect(find(facts({ muted: false }), 'mute')?.value).toBe('Включены');
    expect(find(facts({ fontSizePt: 17 }), 'font_size')?.value).toBe('17 пт');
    expect(find(facts({ fontSizePt: null }), 'font_size')?.value).toBe('Как в приложении');
    expect(find(facts({ autoTranslate: true }), 'auto_translate')?.toggle).toBe(true);
    const off = find(facts({ amAdmin: true, disappearMs: null }), 'disappear')?.value;
    const on = find(facts({ amAdmin: true, disappearMs: 86_400_000 }), 'disappear')?.value;
    expect(off).toBeTruthy();
    expect(on).toBeTruthy();
    expect(on).not.toBe(off);
  });

  it('очистка истории помечена разрушающей, и только она', () => {
    const danger = items(facts({ amAdmin: true })).filter((i) => i.danger === true);
    expect(danger.map((i) => i.id)).toEqual(['clear_history']);
  });

  it('id не повторяются в одном окне', () => {
    for (const f of [facts({ amAdmin: false }), facts({ amAdmin: true })]) {
      const ids = groupSettingIds(f);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('модель ничего не рисует: React в ней не участвует', () => {
    const src = fs.readFileSync(path.join(__dirname, '../groupHubModel.ts'), 'utf8');
    expect(src).not.toContain("from 'react'");
    expect(src).not.toContain("react-native");
    // Ровно два импорта — оба за словами о текущем значении.
    expect(src.match(/^import .*$/gm) ?? []).toHaveLength(2);
  });
});
