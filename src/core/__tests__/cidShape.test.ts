/**
 * cidShape — форма настоящего CID живёт в одном месте, и хвост переписки
 * принимает только её.
 *
 * v4.32.432. Правило «в хвост переписки пишем только настоящий CID» записано
 * словами трижды: v4.32.120 #6 на приёме, v4.32.128 в sendMessageWork и ещё
 * раз рядом в retrySendDm. Проверялось оно ровно в одном месте из пяти, а в
 * retrySendDm нарушалось: строкой ниже собственного комментария туда уезжал
 * `fallback:<uuid>`. Дальше плейсхолдер уходил в поле «предыдущее»
 * следующего сообщения, получатель отбрасывал его по форме, и обход истории
 * вставал на призрачном хвосте.
 *
 * Замер: сама форма `[A-Za-z0-9]{46,128}` была выписана от руки в девяти
 * файлах (profile, storage/sync, feedService, messageStore, dmRetryPayload,
 * messageSync, contacts, media/gatewayUrl — и только последний экспортировал
 * её наружу). Рядом жила вторая, более слабая проверка — список запрещённых
 * префиксов `lan:`/`fallback:`, который пропускал и пустую строку, и любой
 * незнакомый плейсхолдер.
 *
 * Теперь форма одна (core/cid), а проверка стоит внутри самой записи хвоста —
 * не у вызывающих, чтобы её нельзя было забыть.
 */
import * as fs from 'fs';
import * as path from 'path';

import { isPlainCid, PLAIN_CID_RE } from '../cid';

const SRC = path.join(__dirname, '..', '..');
const HOME = path.join('core', 'cid.ts');

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function codeLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*'));
}

function relKey(full: string): string {
  return path.relative(SRC, full);
}

const FILES = collect(SRC).map((full) => ({
  key: relKey(full),
  lines: codeLines(fs.readFileSync(full, 'utf8')),
}));

/** Литеральная форма CID, выписанная от руки. */
const HAND_ROLLED = /\[A-Za-z0-9\]\{46,\s*128\}/;
/** Список запрещённых префиксов вместо проверки формы. */
const PREFIX_CHECK = /startsWith\(\s*'(?:lan|fallback):'\s*\)/;

describe('форма CID выписана один раз', () => {
  it('литерал формы встречается только в core/cid', () => {
    const offenders = FILES
      .filter((f) => f.key !== HOME && f.lines.some((l) => HAND_ROLLED.test(l)))
      .map((f) => f.key)
      .sort();
    expect(offenders).toEqual([]);
  });

  it('правило не пустое: исторические формы распознаются, а живой код — нет', () => {
    expect(HAND_ROLLED.test("if (/^[A-Za-z0-9]{46,128}$/.test(head)) {")).toBe(true);
    expect(HAND_ROLLED.test("const CID_RE = /^[A-Za-z0-9]{46,128}$/;")).toBe(true);
    expect(HAND_ROLLED.test('if (!isPlainCid(head)) {')).toBe(false);
    expect(HAND_ROLLED.test("const ID_RE = /^[A-Za-z0-9]{8,64}$/;")).toBe(false);
  });

  it('дом действительно экспортирует форму и предикат', () => {
    const home = FILES.find((f) => f.key === HOME);
    expect(home).toBeDefined();
    expect(home?.lines.some((l) => l.startsWith('export const PLAIN_CID_RE'))).toBe(true);
    expect(home?.lines.some((l) => l.startsWith('export function isPlainCid'))).toBe(true);
  });
});

describe('предикат отсекает плейсхолдеры', () => {
  const real = `Qm${'a'.repeat(44)}`;

  it('настоящий CID проходит', () => {
    expect(isPlainCid(real)).toBe(true);
    expect(PLAIN_CID_RE.test(real)).toBe(true);
  });

  it('плейсхолдеры и мусор не проходят', () => {
    for (const bad of [
      '',
      `fallback:${'0'.repeat(40)}`,
      `lan:${'0'.repeat(44)}`,
      `nb:${'0'.repeat(44)}`,
      'a'.repeat(45),
      'a'.repeat(129),
      `../../${'a'.repeat(40)}`,
      `${'a'.repeat(40)}/../evil.example/p.png`,
      null,
      undefined,
      42,
    ]) {
      expect(isPlainCid(bad)).toBe(false);
    }
  });
});

describe('хвост переписки принимает только настоящий CID', () => {
  const profile = fs.readFileSync(path.join(SRC, 'core', 'identity', 'profile.ts'), 'utf8');
  const body = profile.slice(profile.indexOf('export async function setLocalConversationTip'));
  const head = codeLines(body.slice(0, body.indexOf('\n}')));

  it('проверка стоит до любой работы и выходит без записи', () => {
    const guard = head.findIndex((l) => l === 'if (!isPlainCid(messageCid)) {');
    const work = head.findIndex((l) => l.includes('await') || l.includes('tips[pairKey]'));
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(work).toBeGreaterThan(guard);
    expect(head.slice(guard, work)).toContain('return;');
  });

  it('ни один вызов не передаёт плейсхолдер', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      for (const l of f.lines) {
        if (!l.includes('setLocalConversationTip(')) continue;
        if (/setLocalConversationTip\([^)]*(?:fallbackRef|lanRef|`fallback:|`lan:)/.test(l)) {
          offenders.push(`${f.key}: ${l}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('правило не пустое: прежняя строка retrySendDm была бы поймана', () => {
    const was = 'await setLocalConversationTip(pairKey, fallbackRef);';
    expect(/setLocalConversationTip\([^)]*(?:fallbackRef|lanRef|`fallback:|`lan:)/.test(was)).toBe(true);
  });
});

describe('слабая проверка по префиксам не вернулась', () => {
  it('список префиксов больше не заменяет проверку формы', () => {
    const hits = FILES
      .flatMap((f) => f.lines.filter((l) => PREFIX_CHECK.test(l)).map((l) => `${f.key}: ${l}`))
      .sort();
    // Единственное оставшееся место спрашивает не «настоящий ли это CID», а
    // «стоит ли вообще идти за этим ref в IPFS» — и отвечает до похода.
    expect(hits).toEqual(["core/social/messaging.ts: if (cid.startsWith('fallback:')) {"]);
  });

  it('предикат берут из общего дома, а не из сборки адреса шлюза', () => {
    const offenders = FILES
      .filter((f) => f.lines.some((l) => l.includes('isPlainCid') && l.includes('gatewayUrl')))
      .map((f) => f.key);
    expect(offenders).toEqual([]);
  });
});
