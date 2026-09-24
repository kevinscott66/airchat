/**
 * «Слишком большой» говорят про размер, а не про IPFS (v4.32.841).
 *
 * Дефект. Один и тот же отказ был написан на экранах пятью способами, и два из
 * них называли машинерию:
 *   «Без IPFS-сервера видео передаётся вложением, а его предел — 8 МБ»
 *   «Файл слишком большой: без IPFS-сервера предел — 8 МБ»
 * Обе фразы стояли в ветке `!isIpfsEnabled()`, а `isIpfsEnabled` на телефоне
 * возвращает `false` всегда: это kill switch с v4.32.19, и настройки для него
 * нет ни на одном экране. То есть человек видит ровно эту ветку — и только её.
 *
 * Цена. Названа причина, которую человек не понимает и изменить не может, и
 * сказана неправда: будто существует «IPFS-сервер», после которого предел
 * вырастет. Вторая ветка, где написано по-человечески, недостижима — и совет
 * «обрежьте видео», единственное осмысленное действие, достался как раз ей:
 * в видимой ветке для видео он был, а для документа не было ничего.
 *
 * Правка. Заголовок и тело отказа — в uploadRoute, рядом с пределом, который
 * они называют. Ветки нет: предел один, и говорят про него.
 */

import fs from 'fs';
import path from 'path';

import { MAX_BLOB_BYTES } from '../blobRef';
import {
  IPFS_DOC_MAX_BYTES,
  IPFS_VIDEO_MAX_BYTES,
  OVERSIZE_TITLE,
  formatLimit,
  oversizeAdvice,
  oversizeText,
  uploadLimitBytes,
} from '../uploadRoute';

const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(__dirname, '..', '..', '..', ...parts), 'utf8');

/** Только код: комментарий, где написано «как надо», за исходник не считается. */
const codeOnly = (s: string): string =>
  s
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

/** Экранные тексты этих двух файлов и есть то, что человек читает. */
const CHAT = codeOnly(read('ui', 'screens', 'ChatScreen.tsx'));
const GROUPS = codeOnly(read('ui', 'screens', 'GroupsScreen.tsx'));

describe('отказ по размеру говорит про размер', () => {
  it('ни в заголовке, ни в теле нет слова про сервер', () => {
    const all = [
      oversizeText(MAX_BLOB_BYTES),
      oversizeText(MAX_BLOB_BYTES, 'video'),
      oversizeText(MAX_BLOB_BYTES, 'photo'),
      oversizeAdvice(MAX_BLOB_BYTES),
      oversizeAdvice(MAX_BLOB_BYTES, 'video'),
      ...Object.values(OVERSIZE_TITLE),
    ].join('\n');
    // ПРОВЕРКА НЕ ПУСТАЯ: тексты непустые и про размер в них сказано.
    expect(all).toContain(formatLimit(MAX_BLOB_BYTES));
    expect(all).not.toMatch(/IPFS/i);
    expect(all).not.toMatch(/сервер/i);
    expect(all).not.toMatch(/вложени/i);
  });

  it('предел называют тем же числом, по которому отказывают', () => {
    const limit = uploadLimitBytes({ ipfsEnabled: false });
    expect(limit).toBe(MAX_BLOB_BYTES);
    expect(oversizeText(limit)).toContain(formatLimit(limit));
    // Округление вниз: подпись не имеет права назвать больше, чем пропустят.
    expect(oversizeText(MAX_BLOB_BYTES - 1)).not.toBe(oversizeText(MAX_BLOB_BYTES));
  });

  it('видео советуют обрезать, файлу такого совета не дают', () => {
    expect(oversizeAdvice(MAX_BLOB_BYTES, 'video')).toContain('Обрежьте видео');
    expect(oversizeAdvice(MAX_BLOB_BYTES, 'file')).not.toContain('Обрежьте');
    expect(oversizeAdvice(MAX_BLOB_BYTES, 'photo')).not.toContain('Обрежьте');
    // Совет — хвост к пределу, а не вместо него.
    expect(oversizeAdvice(MAX_BLOB_BYTES, 'video').startsWith('Предел —')).toBe(true);
  });

  it('строка без заголовка несёт ту же мысль целиком', () => {
    for (const kind of ['file', 'video', 'photo'] as const) {
      const line = oversizeText(MAX_BLOB_BYTES, kind);
      expect(line.startsWith(OVERSIZE_TITLE[kind])).toBe(true);
      expect(line).toContain(formatLimit(MAX_BLOB_BYTES));
      expect(line.endsWith(oversizeAdvice(MAX_BLOB_BYTES, kind).slice(-1))).toBe(true);
    }
    // Три предмета — три названия, и ни одно не повторяет другое.
    expect(new Set(Object.values(OVERSIZE_TITLE)).size).toBe(3);
  });

  it('по умолчанию — про файл: вызов без вида не должен молчать про предмет', () => {
    expect(oversizeText(MAX_BLOB_BYTES)).toBe(oversizeText(MAX_BLOB_BYTES, 'file'));
    expect(oversizeAdvice(MAX_BLOB_BYTES)).toBe(oversizeAdvice(MAX_BLOB_BYTES, 'file'));
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('на телефоне IPFS выключен наглухо — значит видна была ровно та ветка', () => {
    const helia = read('core', 'transport', 'ipfs', 'heliaNode.ts');
    const body = helia.slice(
      helia.indexOf('export function isIpfsEnabled()'),
      helia.indexOf('export function setHeliaLowPowerOverride'),
    );
    expect(body).toContain("if (Platform.OS !== 'android' && Platform.OS !== 'ios') return true;");
    expect(body).toContain('return false;');
    // Ни настройки, ни аргумента: на телефоне это не выбор человека.
    expect(body).not.toContain('loadConfig');
    expect(codeOnly(helia)).toContain('export function isIpfsEnabled(): boolean {');
  });

  it('предел, который человек встречает, — блобовый, и он меньше IPFS-ных', () => {
    expect(uploadLimitBytes({ ipfsEnabled: false })).toBe(MAX_BLOB_BYTES);
    expect(uploadLimitBytes({ ipfsEnabled: false, ipfsMaxBytes: IPFS_VIDEO_MAX_BYTES })).toBe(
      MAX_BLOB_BYTES,
    );
    expect(MAX_BLOB_BYTES).toBeLessThan(IPFS_VIDEO_MAX_BYTES);
    expect(MAX_BLOB_BYTES).toBeLessThan(IPFS_DOC_MAX_BYTES);
    // Отсюда и неправда старого текста: «без IPFS-сервера» намекало, что с ним
    // предел вырастет, — вырос бы, но включить его человеку нечем.
  });

  it('старых формулировок на экранах не осталось ни одной', () => {
    for (const src of [CHAT, GROUPS]) {
      expect(src).not.toContain('Без IPFS-сервера видео передаётся вложением');
      expect(src).not.toContain('без IPFS-сервера предел');
      expect(src).not.toContain('Максимальный размер видео —');
      expect(src).not.toContain('Максимальный размер файла —');
      expect(src).not.toContain('Файл слишком большой (макс');
    }
  });

  it('про IPFS человеку на этих экранах больше не говорят', () => {
    // В комментариях IPFS остаётся — это про устройство кода. В строках, которые
    // видит человек, его быть не должно.
    const quoted = (src: string): string[] => [
      ...src.matchAll(/(['"`])((?:[^\\\n]|\\.)*?)\1/g),
    ].map((m) => m[2]);
    for (const src of [CHAT, GROUPS]) {
      const shown = quoted(src).filter((t) => /[А-Яа-яЁё]/.test(t));
      expect(shown.length).toBeGreaterThan(50);
      expect(shown.filter((t) => /IPFS/i.test(t))).toEqual([]);
    }
  });
});

describe('форма исходников', () => {
  it('оба экрана берут отказ из общего места, а не пишут свой', () => {
    for (const src of [CHAT, GROUPS]) {
      expect(src).toContain('oversizeText');
      // Ни один из трёх заголовков больше не записан на экране литералом.
      for (const title of Object.values(OVERSIZE_TITLE)) expect(src).not.toContain(title);
    }
    expect(CHAT).toContain('Alert.alert(OVERSIZE_TITLE.video, oversizeAdvice(videoMaxBytes, \'video\'));');
    expect(GROUPS).toContain('Alert.alert(OVERSIZE_TITLE.video, oversizeAdvice(videoMaxBytes, \'video\'));');
    expect(CHAT).toContain('Alert.alert(OVERSIZE_TITLE.file, oversizeAdvice(docMaxBytes));');
    expect(GROUPS).toContain('showError(oversizeText(docMaxBytes));');
  });

  it('ветки «есть IPFS / нет IPFS» в отказе не осталось', () => {
    for (const src of [CHAT, GROUPS]) {
      expect(src).not.toContain('viaBlob\n            ?');
      expect(src).not.toContain('ipfsOn\n          ?');
    }
  });

  it('аватар группы и документ в чате зовут ту же фразу', () => {
    expect(GROUPS).toContain("oversizeText(up.limitBytes, 'photo')");
    expect(CHAT).toContain('oversizeText(up.limitBytes)');
    expect(GROUPS).toContain('oversizeText(up.limitBytes)');
  });

  it('заголовок, совет и предел лежат в одном файле', () => {
    const route = codeOnly(read('core', 'media', 'uploadRoute.ts'));
    expect(route).toContain('export const OVERSIZE_TITLE = {');
    expect(route).toContain('export function oversizeAdvice(');
    expect(route).toContain('export function oversizeText(');
    // Совет — один словарь на все виды: иначе через версию он снова разъедется.
    expect(route).toContain('const OVERSIZE_HINT: Record<OversizeKind, string> = {');
    expect(route.match(/Обрежьте видео/g)).toHaveLength(1);
  });
});
