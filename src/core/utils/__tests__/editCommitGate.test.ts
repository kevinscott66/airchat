/**
 * Одна правка поля — одно сохранение (v4.32.515).
 *
 * Название и описание группы правятся на месте: нажал на текст — он стал полем
 * ввода — ушёл с него — сохранилось. Поле названия спрашивают ДВА события:
 * `onSubmitEditing` по клавише «готово» и `onBlur`, потому что submit у
 * однострочного поля снимает фокус. Оба зовут один обработчик, и оба успевают
 * войти в него до первого await.
 *
 * Отсечь второй вход было нечем. Сравнивали с `group.name`, а `group` приезжает
 * пропом из навигационного состояния (`<GroupMembersScreen group={nav.group}>`),
 * которое заводится один раз при переходе и после записи в базу не
 * обновляется. Проп заморожен на том, что было при входе на карточку.
 *
 * Отсюда две беды, обе у того, кто правит:
 *
 *   • запись, тост и системная строка задваивались. Получатели конверта повтор
 *     отбрасывают (`env.name !== group.name` в ветке 'meta'), поэтому лишняя
 *     строка «Группа переименована в «X»» оставалась ровно в одной истории из
 *     всех — та же несимметричность, что и в v4.32.514;
 *   • вернуть прежнее название в том же сеансе было нельзя: A→B, тут же B→A —
 *     сравнение с замороженным пропом (A) отвечает «менять нечего», поле
 *     закрывается, на экране A, в базе B.
 *
 * И третья мелочь рядом: отказ базы улетал необработанным отклонением
 * обещания — `void saveName()` без catch.
 */
import fs from 'fs';
import path from 'path';

import { createEditCommitGate } from '../editCommitGate';

const SRC = path.join(__dirname, '..', '..', '..');
const SCREEN = fs.readFileSync(path.join(SRC, 'ui', 'screens', 'GroupsScreen.tsx'), 'utf8');

describe('калитка пускает ровно одно сохранение на правку', () => {
  it('то же значение, что и открыли, сохранять незачем', () => {
    const gate = createEditCommitGate('Двор');
    expect(gate.begin('Двор')).toBe(false);
  });

  it('новое значение проходит', () => {
    const gate = createEditCommitGate('Двор');
    expect(gate.begin('Подъезд')).toBe(true);
  });

  it('второй вход, пока запись в полёте, не проходит — это и есть задвоение', () => {
    // Клавиша «готово»: сперва onSubmitEditing, следом onBlur. Оба входят до
    // того, как первая запись успела вернуться.
    const gate = createEditCommitGate('Двор');
    expect(gate.begin('Подъезд')).toBe(true);
    expect(gate.begin('Подъезд')).toBe(false);
  });

  it('и третий тоже — сколько бы событий ни пришло', () => {
    const gate = createEditCommitGate('Двор');
    gate.begin('Подъезд');
    expect([gate.begin('Подъезд'), gate.begin('Подъезд')]).toEqual([false, false]);
  });

  it('после записи повтор того же значения не проходит', () => {
    const gate = createEditCommitGate('Двор');
    gate.begin('Подъезд');
    gate.commit('Подъезд');
    expect(gate.begin('Подъезд')).toBe(false);
  });

  it('вернуть прежнее название после записи МОЖНО', () => {
    // Ровно то, чего не позволяло сравнение с замороженным пропом.
    const gate = createEditCommitGate('Двор');
    gate.begin('Подъезд');
    gate.commit('Подъезд');
    expect(gate.begin('Двор')).toBe(true);
  });

  it('калитка знает, что на диске, а не что было при входе', () => {
    const gate = createEditCommitGate('Двор');
    expect(gate.last()).toBe('Двор');
    gate.begin('Подъезд');
    expect(gate.last()).toBe('Двор');
    gate.commit('Подъезд');
    expect(gate.last()).toBe('Подъезд');
  });

  it('сорвавшаяся запись возвращает право попробовать снова', () => {
    const gate = createEditCommitGate('Двор');
    gate.begin('Подъезд');
    gate.rollback();
    expect(gate.begin('Подъезд')).toBe(true);
    expect(gate.last()).toBe('Двор');
  });

  it('откат после удачной записи ничего не откатывает', () => {
    // В экране commit и rollback стоят в try и catch одного блока: если
    // сорвётся не запись, а системная строка после неё, откат придёт уже
    // после commit. Сохранённое значение он трогать не смеет — оно на диске.
    const gate = createEditCommitGate('Двор');
    gate.begin('Подъезд');
    gate.commit('Подъезд');
    gate.rollback();
    expect(gate.last()).toBe('Подъезд');
    expect(gate.begin('Подъезд')).toBe(false);
  });

  it('пустая строка — законное значение, а не «нечего сохранять»', () => {
    // Описание стирают именно так (см. v4.32.261).
    const gate = createEditCommitGate('было описание');
    expect(gate.begin('')).toBe(true);
    gate.commit('');
    expect(gate.last()).toBe('');
    expect(gate.begin('')).toBe(false);
  });

  it('две калитки не знают друг о друге', () => {
    // Название и описание правятся независимо и сохраняются независимо.
    const name = createEditCommitGate('Двор');
    const desc = createEditCommitGate('');
    name.begin('Подъезд');
    expect(desc.begin('Соседи по подъезду')).toBe(true);
  });
});

describe('BEFORE — чем отвечало сравнение с замороженным пропом', () => {
  /** Прежняя проверка: «менять есть что?» у значения, взятого при входе. */
  const asBefore = (frozenProp: string, next: string) => next !== frozenProp;

  it('пропускала второй заход, потому что проп не обновлялся', () => {
    const frozen = 'Двор';
    expect(asBefore(frozen, 'Подъезд')).toBe(true);
    // Запись прошла, а проп прежний — значит и второе событие проходит.
    expect(asBefore(frozen, 'Подъезд')).toBe(true);
  });

  it('и запрещала вернуть прежнее название', () => {
    const frozen = 'Двор';
    // A→B записали, тут же B→A: на диске «Подъезд», проп говорит «Двор».
    expect(asBefore(frozen, 'Двор')).toBe(false);
  });

  it('калитка отвечает на оба вопроса иначе', () => {
    const gate = createEditCommitGate('Двор');
    expect(gate.begin('Подъезд')).toBe(true);
    expect(gate.begin('Подъезд')).toBe(false);
    gate.commit('Подъезд');
    expect(gate.begin('Двор')).toBe(true);
  });
});

/** Рэтчет формы: экран спрашивает калитку, а не проп. */
describe('форма исходников', () => {
  it('прежнего сравнения с пропом в экране нет', () => {
    expect(SCREEN).not.toContain('n === group.name');
    expect(SCREEN).not.toContain("d === (group.description ?? '')");
  });

  it('обе правки на месте проходят через калитку', () => {
    for (const gate of ['nameGate', 'descGate']) {
      expect(SCREEN).toContain(`${gate}.begin(`);
      expect(SCREEN).toContain(`${gate}.commit(`);
      expect(SCREEN).toContain(`${gate}.rollback(`);
    }
  });

  it('калитка переживает перерисовку', () => {
    // Обычная переменная завелась бы заново на каждом рендере, и вся защита
    // свелась бы к нулю ровно там, где она нужна.
    expect(SCREEN).toContain('useRef(createEditCommitGate(group.name)).current');
    expect(SCREEN).toContain("useRef(createEditCommitGate(group.description ?? '')).current");
  });

  it('замороженный проп больше не значится в зависимостях сохранения', () => {
    // Пока он там, любая его подмена снова превращается в источник правды.
    const saveName = SCREEN.slice(SCREEN.indexOf('const saveName = useCallback'));
    expect(saveName.slice(0, saveName.indexOf('const saveDesc'))).not.toContain('group.name,');
  });

  it('отказ базы договаривается словами, а не молчанием', () => {
    expect(SCREEN).toContain("showError('Не удалось переименовать группу')");
    expect(SCREEN).toContain("showError('Не удалось сохранить описание')");
  });

  it('поле закрывается при любом исходе', () => {
    // finally, а не хвост удачной ветки: иначе сорвавшаяся запись оставляла бы
    // открытое поле ввода без единого слова о том, что случилось.
    expect(SCREEN).toContain('} finally {\n      setEditingName(false);');
    expect(SCREEN).toContain('} finally {\n      setEditingDesc(false);');
  });

  it('получатель конверта повтор и так отбрасывал — задваивал только автор', () => {
    // v4.32.577: сравнение переехало в groupMetaEvents — там к двум случаям
    // добавился третий (своё название не прочиталось ключом данных). Само
    // отбрасывание повтора никуда не делось, что и проверяется.
    const messaging = fs.readFileSync(path.join(SRC, 'core', 'social', 'groupMessaging.ts'), 'utf8');
    expect(messaging).toContain('decideMetaField(env.name, group.name, group.nameUnreadable)');
    const metaEvents = fs.readFileSync(path.join(SRC, 'core', 'social', 'groupMetaEvents.ts'), 'utf8');
    expect(metaEvents).toContain('if (incoming === own) return NOTHING;');
  });
});
