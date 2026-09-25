/**
 * Адрес узла и CID больше не уезжают в системный журнал целиком (v4.32.944).
 *
 * Дефект. Сообщения с префиксом `ipfs_` release-сборка дублирует в системный
 * журнал устройства (`mirrorJsonToConsoleInRelease`). Правило «адрес целиком
 * туда не кладём» держалось на памяти автора каждой строки: на удачных путях
 * стоял `slice(0, 40)`, на шлюзе — `slice(0, 64)`, а на путях отказа — адрес
 * целиком. То же с CID: `cidPrefix` на удачных, `cid` целиком в `ipfs_cat_failed`.
 *
 * Цена. Строк отказа больше всего как раз тогда, когда что-то не работает, —
 * то есть правило не соблюдалось ровно в тот момент, когда журнал и пишется.
 * Адрес узла говорит, чей это узел и в какой он сети, а у Kubo RPC доступ
 * ходит и в `user:пароль@`, и в параметрах запроса. CID целиком говорит, что
 * именно человек скачивал. Системный журнал читается с подключённого
 * компьютера и попадает в диагностические выгрузки — то есть уходит дальше
 * устройства.
 *
 * Правка. Обрезка названа один раз, в `ipfs/logFields`, и зовётся отовсюду.
 * Сначала выбрасывается то, чему в журнале не место по смыслу (имя с паролем,
 * параметры, якорь), потом ограничивается длина: слепой обрез оставил бы то,
 * что случайно попало в первые сорок знаков, а ключ лежит в хвосте.
 *
 * Границы. Это про журнал, а не про сеть: запросы уходят по полному адресу, в
 * поведении узла не меняется ничего. Проверка ниже сторожит весь каталог
 * целиком — новая строка с голым `url` не пройдёт, даже если её напишут в
 * соседнем файле.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { cidForLog, urlForLog } from '../ipfs/logFields';

const DIR = join(__dirname, '..', 'ipfs');

function sources(): { name: string; body: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, body: readFileSync(join(DIR, name), 'utf8') }));
}

/** Все вызовы журнала каталога — вместе с их полями, как они написаны. */
function logCalls(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const { name, body } of sources()) {
    const re = /log\.(?:debug|info|warn|error)\((?:[^()]|\([^()]*\))*\)/g;
    for (const m of body.match(re) ?? []) out.push({ file: name, text: m });
  }
  return out;
}

describe('ПРОВЕРКА НЕ ПУСТАЯ: в каталоге есть что сторожить', () => {
  it('вызовы журнала находятся', () => {
    const calls = logCalls();
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.some((c) => c.text.includes('ipfs_add_via_http'))).toBe(true);
  });

  it('обрезка адреса вообще что-то оставляет', () => {
    expect(urlForLog('https://узел.example/api/v0/add')).toBe('https://узел.example/api/v0/add');
  });
});

describe('в журнал не уходит адрес целиком', () => {
  it('ни один вызов не кладёт голый url или cid', () => {
    const bad = logCalls().filter((c) => /[{,]\s*(url|cid)\s*[,}]/.test(c.text));
    expect(bad.map((c) => `${c.file}: ${c.text.slice(0, 90)}`)).toEqual([]);
  });

  it('обрезка названа одним способом, а не тремя', () => {
    const offenders = sources()
      .filter((f) => f.name !== 'logFields.ts')
      .filter((f) => f.body.includes('url.slice(') || f.body.includes('cid.slice('))
      .map((f) => f.name);
    expect(offenders).toEqual([]);
  });
});

describe('что именно остаётся от адреса', () => {
  it('параметры запроса не остаются: ключ лежит там', () => {
    expect(urlForLog('https://gw.example/api/v0/add?token=секрет')).toBe(
      'https://gw.example/api/v0/add',
    );
  });

  it('якорь не остаётся', () => {
    expect(urlForLog('https://gw.example/api#часть')).toBe('https://gw.example/api');
  });

  it('имя с паролем в адресе не остаётся', () => {
    expect(urlForLog('http://вася:пароль@127.0.0.1:5001/api/v0/add')).toBe(
      'http://127.0.0.1:5001/api/v0/add',
    );
  });

  it('длинный путь обрезается с пометкой', () => {
    const long = `https://gw.example/${'a'.repeat(200)}`;
    const cut = urlForLog(long);
    expect(cut.length).toBe(81);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('короткий адрес не портится', () => {
    expect(urlForLog('http://127.0.0.1:5001/api/v0/add')).toBe('http://127.0.0.1:5001/api/v0/add');
  });
});

describe('что остаётся от CID', () => {
  it('начала хватает связать строки, а содержимое по нему не достать', () => {
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    expect(cidForLog(cid)).toBe('QmYwAPJzv5CZ…');
  });

  it('короткий опознаватель остаётся как есть', () => {
    expect(cidForLog('Qm123')).toBe('Qm123');
  });
});
