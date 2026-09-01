/**
 * Короткое нажатие по микрофону больше не оставляет запись включённой
 * (v4.32.493).
 *
 * Между нажатием и работающей записью стоят два ожидания: переключение
 * звукового режима и подготовка рекордера. Ссылка на рекордер присваивалась
 * только после них, а отпускание проверяло именно её и при пустой молча
 * выходило. Короткое нажатие целиком помещается в это окно.
 *
 * Что видел человек: тапнул по микрофону вместо того, чтобы удержать. На
 * экране ничего — а микрофон уже открыт и не закроется: отпускание потеряно,
 * два таймера тикают, файл пишется. Следующее нажатие заводило второй
 * рекордер поверх первого, и первый держал микрофон до перезапуска
 * приложения.
 */
import {
  failed,
  IDLE_GATE,
  pressIn,
  pressOut,
  ready,
  type RecorderGate,
} from '../recorderGate';

/** Полное удержание: нажали, дождались готовности, отпустили. */
function hold(g: RecorderGate): RecorderGate {
  const p = pressIn(g);
  const r = ready(p.gate, p.token);
  return pressOut(r.gate).gate;
}

describe('обычное удержание', () => {
  it('нажатие заводит запись, готовность её оставляет', () => {
    const p = pressIn(IDLE_GATE);
    expect(p.start).toBe(true);
    expect(p.gate.phase).toBe('starting');
    const r = ready(p.gate, p.token);
    expect(r.keep).toBe(true);
    expect(r.gate.phase).toBe('recording');
  });

  it('отпускание останавливает запись и возвращает кнопку в исходное', () => {
    const p = pressIn(IDLE_GATE);
    const r = ready(p.gate, p.token);
    const out = pressOut(r.gate);
    expect(out.stop).toBe(true);
    expect(out.gate.phase).toBe('idle');
  });

  it('кнопка переживает несколько удержаний подряд', () => {
    let g = IDLE_GATE;
    for (let i = 0; i < 5; i++) g = hold(g);
    expect(g.phase).toBe('idle');
    expect(pressIn(g).start).toBe(true);
  });
});

describe('короткое нажатие: отпустили, пока рекордер готовился', () => {
  it('отпускание не теряется — оно снимает намерение', () => {
    const p = pressIn(IDLE_GATE);
    const out = pressOut(p.gate);
    expect(out.gate.phase).toBe('idle');
    // Останавливать пока нечего: рекордера ещё нет.
    expect(out.stop).toBe(false);
  });

  it('готовность после отпускания запись НЕ оставляет', () => {
    const p = pressIn(IDLE_GATE);
    const out = pressOut(p.gate);
    const r = ready(out.gate, p.token);
    expect(r.keep).toBe(false);
    expect(r.gate.phase).toBe('idle');
  });

  it('и кнопка остаётся годной для следующего нажатия', () => {
    const p = pressIn(IDLE_GATE);
    const r = ready(pressOut(p.gate).gate, p.token);
    expect(pressIn(r.gate).start).toBe(true);
  });
});

describe('второй рекордер поверх первого', () => {
  it('нажатие во время подготовки не заводит второй', () => {
    const first = pressIn(IDLE_GATE);
    const second = pressIn(first.gate);
    expect(second.start).toBe(false);
    expect(second.gate).toBe(first.gate);
  });

  it('нажатие во время записи не заводит второй', () => {
    const p = pressIn(IDLE_GATE);
    const r = ready(p.gate, p.token);
    expect(pressIn(r.gate).start).toBe(false);
  });

  it('готовность СТАРОГО нажатия не оживляет запись под новым', () => {
    const first = pressIn(IDLE_GATE);
    const afterRelease = pressOut(first.gate).gate;
    const second = pressIn(afterRelease);
    // Первый рекордер доготовился уже после того, как человек нажал снова.
    const stale = ready(second.gate, first.token);
    expect(stale.keep).toBe(false);
    expect(stale.gate.phase).toBe('starting');
    expect(stale.gate.token).toBe(second.token);
  });
});

describe('экран закрылся во время записи', () => {
  it('уход снимает намерение так же, как отпускание', () => {
    const p = pressIn(IDLE_GATE);
    const r = ready(p.gate, p.token);
    const unmount = pressOut(r.gate);
    expect(unmount.stop).toBe(true);
    expect(ready(unmount.gate, p.token).keep).toBe(false);
  });

  it('отпускание на пустой кнопке ничего не ломает', () => {
    const out = pressOut(IDLE_GATE);
    expect(out.stop).toBe(false);
    expect(out.gate.phase).toBe('idle');
    expect(pressIn(out.gate).start).toBe(true);
  });
});

describe('неудачный запуск', () => {
  it('возвращает кнопку в исходное, а не оставляет залипшей', () => {
    const p = pressIn(IDLE_GATE);
    const g = failed(p.gate, p.token);
    expect(g.phase).toBe('idle');
    expect(pressIn(g).start).toBe(true);
  });

  it('ошибка старого запуска не сбивает новое нажатие', () => {
    const first = pressIn(IDLE_GATE);
    const second = pressIn(pressOut(first.gate).gate);
    const g = failed(second.gate, first.token);
    expect(g).toBe(second.gate);
    expect(g.phase).toBe('starting');
  });
});

describe('форма исходников', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'VoiceMessage.tsx'), 'utf8');

  it('отпускание снимает намерение раньше проверки ссылки на рекордер', () => {
    const gate = src.indexOf('const release = pressOut(gateRef.current)');
    const check = src.indexOf('if (!release.stop || !rec) return;');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(gate);
  });

  it('готовность рекордера сверяется с номером нажатия', () => {
    expect(src).toContain('ready(gateRef.current, press.token)');
    expect(src).toContain('await rec.stop();');
  });

  it('уход с экрана снимает намерение', () => {
    expect(src).toContain('gateRef.current = pressOut(gateRef.current).gate;');
  });

  it('состояние кнопки живёт не в исходнике компонента', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', 'recorderGate.ts'), 'utf8')).not.toMatch(/^\s*import\s/m);
  });
});
