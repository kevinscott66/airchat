/**
 * Живая геолокация, которая перестала быть живой.
 *
 * Рассылка координат — обычный setInterval внутри процесса. Приложение
 * закрыли, система выгрузила, сменили профиль — таймер исчезает, и у
 * собеседника до восьми часов горит зелёная плашка LIVE над точкой, которая
 * больше не двигается. Вторая половина той же беды: разбор конверта отвергал
 * закончившуюся сессию, и пузырь схлопывался в пустоту (переписка) или
 * выкладывал сырой JSON (группа).
 */

import fs from 'fs';
import path from 'path';
import {
  LIVELOC_STALE_TICKS,
  LIVELOC_TICK_MS,
  liveLocDetail,
  liveLocStaleAfterMs,
  liveLocState,
  liveLocTitle,
} from '../liveLocFreshness';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const SRC = path.join(__dirname, '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const BUBBLE = (): string => read('ui/screens/chat-components/LiveLocationBubble.tsx');
const GROUPS = (): string => read('ui/screens/GroupsScreen.tsx');
const SERVICE = (): string => read('core/social/liveLocationService.ts');
const ENVELOPE = (): string => read('core/social/locationEnvelope.ts');

describe('порог молчания', () => {
  it('такт совпадает с настоящим тактом рассылки', () => {
    // Модуль без импортов знает такт числом; расхождение сделало бы порог
    // случайным — здесь оно и ловится. Сам liveLocationService сюда не
    // импортируется: он тянет uuid, а тот приходит только модулем ESM.
    const m = SERVICE().match(/export const LIVELOC_UPDATE_INTERVAL_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1].replace(/_/g, ''))).toBe(LIVELOC_TICK_MS);
  });

  it('три такта: два пропуска ещё прощаются', () => {
    expect(LIVELOC_STALE_TICKS).toBe(3);
    expect(liveLocStaleAfterMs()).toBe(90_000);
  });

  it('такт меньше обычного порог не занижает', () => {
    expect(liveLocStaleAfterMs(1_000)).toBe(90_000);
    expect(liveLocStaleAfterMs(60_000)).toBe(180_000);
  });

  it('нечисловой такт — обычный порог', () => {
    for (const v of [undefined, null, NaN, Infinity, -5, 0]) {
      expect(liveLocStaleAfterMs(v as number)).toBe(90_000);
    }
  });
});

describe('состояние сессии', () => {
  const live = { expireAt: NOW + 30 * MIN, now: NOW };

  it('свежая точка — идёт', () => {
    expect(liveLocState({ ...live, updatedAt: NOW - 10_000 })).toBe('live');
    expect(liveLocState({ ...live, updatedAt: NOW - 89_000 })).toBe('live');
  });

  it('молчание длиннее трёх тактов — замерла', () => {
    expect(liveLocState({ ...live, updatedAt: NOW - 91_000 })).toBe('stale');
    expect(liveLocState({ ...live, updatedAt: NOW - 4 * 60 * MIN })).toBe('stale');
  });

  it('срок вышел — закончилась, даже если точка свежая', () => {
    expect(liveLocState({ expireAt: NOW, now: NOW, updatedAt: NOW })).toBe('ended');
    expect(liveLocState({ expireAt: NOW - MIN, now: NOW, updatedAt: NOW })).toBe('ended');
  });

  it('без времени отправки судим только по сроку — за старого отправителя не выдумываем', () => {
    expect(liveLocState(live)).toBe('live');
    expect(liveLocState({ ...live, updatedAt: null })).toBe('live');
    expect(liveLocState({ ...live, updatedAt: NaN })).toBe('live');
  });

  it('время из будущего — расхождение часов, а не свежесть наоборот', () => {
    expect(liveLocState({ ...live, updatedAt: NOW + 10_000 })).toBe('live');
  });

  it('нечисловой срок — «закончилась», а не «идёт»', () => {
    expect(liveLocState({ expireAt: NaN, now: NOW, updatedAt: NOW })).toBe('ended');
    expect(liveLocState({ expireAt: NOW + MIN, now: Infinity })).toBe('ended');
  });
});

describe('что написано в пузыре', () => {
  it('три состояния — три разные строки', () => {
    const titles = ['live', 'stale', 'ended'].map((s) => liveLocTitle(s as 'live'));
    expect(new Set(titles).size).toBe(3);
    expect(liveLocTitle('live')).toBe('Живая геолокация');
    expect(liveLocTitle('ended')).toBe('Геолокация завершена');
  });

  it('замершая сессия не называется живой и говорит, когда была точка', () => {
    const t = liveLocTitle('stale');
    expect(t).not.toBe('Живая геолокация');
    expect(t).toContain('не обновляется');
    expect(liveLocDetail({ expireAt: NOW + 30 * MIN, now: NOW, updatedAt: NOW - 5 * MIN })).toBe(
      'последняя точка 5 мин назад',
    );
  });

  it('идущая сессия говорит, сколько осталось', () => {
    expect(liveLocDetail({ expireAt: NOW + 12 * MIN, now: NOW, updatedAt: NOW })).toBe('ещё 12 мин');
  });

  it('последняя минута — «меньше минуты», а не «ещё 0 мин»', () => {
    expect(liveLocDetail({ expireAt: NOW + 30_000, now: NOW, updatedAt: NOW })).toBe('ещё меньше минуты');
  });

  it('у законченной добавлять к координатам нечего', () => {
    expect(liveLocDetail({ expireAt: NOW - MIN, now: NOW, updatedAt: NOW })).toBe('');
  });
});

describe('форма исходников', () => {
  it('отправитель кладёт в посылку время отправки', () => {
    const s = SERVICE();
    expect(s).toContain('const sentAt = Date.now();');
    expect(s).toContain('ts: sentAt,');
    expect(s).toContain('if (session.stopped || sentAt >= expireAt) return;');
  });

  it('нижняя граница срока снята, верхняя на месте', () => {
    const e = ENVELOPE();
    expect(e).toContain('if (o.expireAt > now + LIVELOC_MAX_AHEAD_MS) return null;');
    expect(e).not.toContain('o.expireAt < now - LIVELOC_MAX_SKEW_MS');
    expect(e).toContain("if (typeof o.ts === 'number' && isFinite(o.ts) && o.ts <= now + LIVELOC_MAX_SKEW_MS) out.ts = o.ts;");
  });

  it('пузырь считает состояние модулем, а не сравнением со сроком', () => {
    const b = BUBBLE();
    expect(b).toContain("from '../../../core/social/liveLocFreshness'");
    expect(b).toContain('const state = liveLocState({ expireAt: meta.expireAt, now, updatedAt: meta.ts });');
    expect(b).toContain('{liveLocTitle(state)}');
    expect(b).not.toContain('const expired =');
    expect(b).toContain('parseLiveLoc(text, now)');
  });

  it('неразобранный конверт — написанная строка, а не пустой пузырь', () => {
    const b = BUBBLE();
    expect(b).toContain('Живая геолокация недоступна');
    expect(b).not.toContain('if (!meta) return null;');
  });

  it('плашка LIVE горит только у идущей сессии', () => {
    const b = BUBBLE();
    expect(b).toContain("const live = state === 'live';");
    expect(b).toContain('{live && (');
    expect(b).not.toContain('{!expired && (');
  });

  it('группа рисует общий пузырь, а не свою копию', () => {
    const g = GROUPS();
    expect(g).toContain("import { LiveLocationBubble } from './chat-components/LiveLocationBubble';");
    expect(g).toContain('<LiveLocationBubble text={item.text} isOutgoing={isMe} />');
    expect(g).not.toContain('parseLiveLoc(item.text)');
    expect(g).not.toContain("import { isLiveLocMessage, parseLiveLoc }");
  });

  it('копия пузыря в группе больше нигде не заведена', () => {
    const g = GROUPS();
    // Подпись цитаты «📡 Живая геолокация» — не пузырь и остаётся.
    expect(g).not.toContain("'Геолокация завершена'");
    expect(g).not.toContain('const expired = Date.now() >= meta.expireAt;');
    expect(g.match(/LIVE<\/Text>/g)).toBeNull();
  });
});
