/**
 * Мост, который не поднялся, больше не выдают за включённый (v4.32.898).
 *
 * Дефект: `await startAgentBridgeIfEnabled();` на экране стоял без разбора
 * ответа. А эта запись отвечает `false` не от нечего делать: либо чтение
 * отметки с диска вернуло не то, что в неё только что записали (`kvGet`
 * гасит отказ чтения и отдаёт `null`), либо ключа доступа в хранилище не
 * нашлось. Подписка в обоих случаях не поднялась.
 *
 * Цена: рычажок при этом уже стоит в «вкл», на диске лежит «включено», и
 * ничего больше мост о себе не сообщает — ни значка, ни уведомления. Человек
 * уходит с экрана в уверенности, что канал открыт, и узнаёт обратное только
 * когда с той стороны никто не ответит. Хуже второе следствие: отметка на
 * диске уцелела, и при следующем запуске `App.tsx` поднимет мост сам — уже
 * молча и без спроса.
 *
 * Правка: ответ разбирается. Не поднялся — отметку возвращаем на место и
 * говорим словами. Не вышло вернуть и отметку — слова другие, потому что
 * положение другое: мост тогда действительно вернётся после перезапуска.
 * Продолжение правила v4.32.801, заведённого на соседней ветке этого же
 * переключателя.
 */
import fs from 'fs';
import path from 'path';

import { userErrorText } from '../userErrorText';

const UI = path.join(__dirname, '..', '..');
const SRC = path.join(UI, '..');
/** Только код: пояснения не должны сами удовлетворять проверку. */
const codeOnly = (rel: string, root = UI): string =>
  fs
    .readFileSync(path.join(root, rel), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const SECTION = 'components/AgentBridgeSettingsSection.tsx';
const MSG_PLAIN = 'Мост не запустился — попробуйте включить ещё раз';
const MSG_STUCK = 'Мост не запустился, но остался включённым — проверьте этот переключатель после перезапуска';
const MSG_REKEY = 'Новый ключ выдан, но мост не перезапустился — выключите и включите его';

describe('несостоявшийся запуск признаётся', () => {
  it('ответ запуска разбирается, а не выбрасывается', () => {
    const body = codeOnly(SECTION);
    expect(body).not.toContain('await startAgentBridgeIfEnabled();');
    const guard = body.indexOf('if (!(await startAgentBridgeIfEnabled())) {');
    expect(guard).toBeGreaterThan(0);
    // Ровно после записи отметки: раньше её спрашивать нечего, позже — поздно.
    const wroteOn = body.indexOf('await setBridgeEnabled(true);');
    expect(wroteOn).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(wroteOn);
  });

  it('отметка возвращается на место, а неудача отката различается', () => {
    const body = codeOnly(SECTION);
    const guard = body.indexOf('if (!(await startAgentBridgeIfEnabled())) {');
    const tail = body.slice(guard, guard + 800);
    expect(tail).toContain('let stuck = false;');
    const back = tail.indexOf('await setBridgeEnabled(false);');
    expect(back).toBeGreaterThan(0);
    expect(tail.indexOf('stuck = true;', back)).toBeGreaterThan(back);
    // Откат не должен утаскивать за собой весь обработчик: отказ записи здесь
    // это не «ничего не случилось», а другая половина новости.
    expect(tail.indexOf('throw new Error(', back)).toBeGreaterThan(back);
    expect(tail).toContain(MSG_STUCK);
    expect(tail).toContain(MSG_PLAIN);
  });

  it('оба текста доходят до экрана, а не подменяются запасным', () => {
    // Ловушка обработчика показывает `userErrorText(e, …)`: машинный
    // опознаватель она отбрасывает, наш текст пропускает как есть. Значит
    // проверять надо не «строка написана», а «строка пройдёт этот фильтр».
    const body = codeOnly(SECTION);
    for (const msg of [MSG_PLAIN, MSG_STUCK]) {
      expect(body).toContain(msg);
      expect(userErrorText(new Error(msg), 'запасной')).toBe(msg);
    }
    expect(MSG_PLAIN).not.toBe(MSG_STUCK);
  });
});

describe('смена ключа не выдаёт половину новости за целую', () => {
  it('упавший перезапуск после смены ключа получает свои слова', () => {
    const body = codeOnly(SECTION);
    expect(body).not.toContain('if (await isBridgeEnabled()) await startAgentBridgeIfEnabled();');
    const at = body.indexOf('if ((await isBridgeEnabled()) && !(await startAgentBridgeIfEnabled())) {');
    expect(at).toBeGreaterThan(0);
    const tail = body.slice(at, at + 400);
    expect(tail).toContain(MSG_REKEY);
    // «Выдан новый ключ» после этого не произносится: ключ выдан, но моста нет.
    const said = tail.indexOf(MSG_REKEY);
    expect(tail.indexOf('return;', said)).toBeGreaterThan(said);
    expect(body.indexOf("showSuccess('Выдан новый ключ. Прежний больше не действует');")).toBeGreaterThan(at);
  });

  it('и этот текст тоже доходит до экрана', () => {
    expect(codeOnly(SECTION)).toContain(MSG_REKEY);
    expect(userErrorText(new Error(MSG_REKEY), 'запасной')).toBe(MSG_REKEY);
    // Запасной текст ловушки здесь был бы прямой неправдой — ключ-то выдан.
    expect(codeOnly(SECTION)).toContain("userErrorText(e, 'Не удалось выдать новый ключ')");
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('удачный путь включения остался прежним и в прежнем порядке', () => {
    const body = codeOnly(SECTION);
    const key = body.indexOf('await loadOrCreateBridgeSecret();');
    expect(key).toBeGreaterThan(0);
    expect(body.indexOf('await refreshKey();', key)).toBeGreaterThan(key);
    expect(body.indexOf('await setBridgeEnabled(true);', key)).toBeGreaterThan(key);
  });

  it('ветка выключения не тронута: запись, потом разрыв сокета', () => {
    const body = codeOnly(SECTION);
    const stop = body.indexOf('stopAgentBridge();');
    expect(stop).toBeGreaterThan(0);
    const write = body.lastIndexOf('await setBridgeEnabled(false);', stop);
    expect(body.slice(write, stop).trim()).toBe('await setBridgeEnabled(false);');
  });

  it('фильтр экрана действительно отбраковывает чужое', () => {
    expect(userErrorText(new Error('agent_bridge_no_secret'), 'запасной')).toBe('запасной');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('запуск отвечает словом, а не броском: молчаливый отказ тут возможен', () => {
    const body = codeOnly('core/bridge/agentBridge.ts', SRC);
    const at = body.indexOf('export async function startAgentBridgeIfEnabled(): Promise<boolean> {');
    expect(at).toBeGreaterThan(0);
    const head = body.slice(at, body.indexOf('openWs(s);', at));
    expect(head).toContain('if (!(await isBridgeEnabled())) return false;');
    expect(head).toContain('return false;');
    // Обе двери молчат сами по себе: наружу уходит `false`, а не исключение.
    expect(head).not.toContain('throw ');
  });

  it('отметка читается гасящим чтением — «включено» на диске может не прочитаться', () => {
    const bridge = codeOnly('core/bridge/agentBridge.ts', SRC);
    expect(bridge).toContain("return (await kvGet(ENABLED_KEY)) === 'true';");
    // `kvGet` — тонкая обёртка над `kvTryGet`, а та ловит отказ базы и
    // возвращает `null`: «не прочиталось» и «записано выключено» на выходе
    // неразличимы. Значит `false` от запуска достижим и после удачной записи.
    const local = codeOnly('core/storage/local.ts', SRC);
    expect(local).toContain('return (await kvTryGet(key))?.value ?? null;');
    const at = local.indexOf('export async function kvTryGet(key: string)');
    expect(at).toBeGreaterThan(0);
    const body2 = local.slice(at, at + 600);
    expect(body2).toContain('} catch (e) {');
    expect(body2.indexOf('return null;', body2.indexOf('} catch (e) {'))).toBeGreaterThan(0);
  });

  it('уцелевшая отметка поднимает мост при следующем запуске', () => {
    expect(codeOnly('App.tsx', SRC)).toContain('m.startAgentBridgeIfEnabled()');
  });
});
