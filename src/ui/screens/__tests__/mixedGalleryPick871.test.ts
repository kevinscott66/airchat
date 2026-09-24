/**
 * v4.32.871. Выбрали в галерее фото и ролик разом — фотографии пропадали.
 *
 * Дефект. Галерея открывается с `MediaTypeOptions.All` и отмечать даёт что
 * угодно вперемешку. Разбор же был устроен так: ветка видео кончалась
 * `return`, а отбор фотографий (`imageAssets`) стоял НИЖЕ неё. Один отмеченный
 * ролик — и до фотографий дело не доходило вовсе. Сверх того, размер роликов
 * проверялся заранее и на всю пачку сразу: один большой отменял и остальные
 * ролики, и фотографии.
 *
 * Цена. Ролик уходил, фотографии исчезали молча — ни в переписке, ни в
 * предпросмотре, ни строчки о том, что их не взяли. Человек видит отправленное
 * видео и считает, что ушло всё. Предварительная проверка при этом ещё и врала:
 * считала она по `fileSize`, который галерея сообщает не всегда, — ролик без
 * заявленного размера её проходил и упирался в тот же предел внутри.
 *
 * Правка. Оба списка считаются сразу, и обе ветки отрабатывают — ровно так,
 * как во втором входе в ту же галерею (`handleAcceptGalleryAssets`), где это
 * сделано правильно с самого начала. Отправка роликов вынесена в отдельную
 * форму: `return` внутри неё больше не уносит с собой фотографии.
 * Предварительная проверка убрана — предел и так проверяется на каждом файле
 * (`uploadMediaToCid`, v4.32.358), а совет «обрежьте» переехал в отчёт о пачке,
 * чтобы не потеряться вместе с ней.
 */
import fs from 'fs';
import path from 'path';

import { batchSendReport } from '../../../core/media/mediaSendReport';

const SCREENS = __dirname.replace(/__tests__$/, '');
const read = (name: string): string => fs.readFileSync(path.join(SCREENS, name), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CHAT = (): string => codeOnly(read('ChatScreen.tsx'));
const GROUPS = (): string => codeOnly(read('GroupsScreen.tsx'));

/**
 * Тело `pickImage` — от запуска галереи до конца обработчика.
 *
 * Якорь — отбор роликов: он в файле один. Сам вызов галереи не годится, в
 * группах их два (второй — выбор картинки для аватара).
 */
function pickBody(src: string): string {
  const mark = "const videoAssets = res.assets.filter((a) => a.type === 'video');";
  const at = src.indexOf(mark);
  expect(at).toBeGreaterThan(0);
  expect(src.indexOf(mark, at + 1)).toBe(-1);
  const start = src.lastIndexOf('const res = await ImagePicker.launchImageLibraryAsync({', at);
  expect(start).toBeGreaterThan(0);
  const end = src.indexOf('\n  }, [', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(start, end);
}

const BODIES = (): Record<string, string> => ({
  'переписка': pickBody(CHAT()),
  'группа': pickBody(GROUPS()),
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('оба экрана по-прежнему открывают галерею одним и тем же входом', () => {
    for (const [name, body] of Object.entries(BODIES())) {
      expect([name, body.length > 400]).toEqual([name, true]);
      expect([name, body.includes("const videoAssets = res.assets.filter((a) => a.type === 'video');")])
        .toEqual([name, true]);
    }
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('галерея и правда отдаёт вперемешку — она открыта на всё сразу', () => {
    for (const [name, body] of Object.entries(BODIES())) {
      expect([name, body.includes('mediaTypes: ImagePicker.MediaTypeOptions.All,')]).toEqual([name, true]);
      expect([name, body.includes('allowsMultipleSelection: true,')]).toEqual([name, true]);
    }
  });

  it('правильный образец рядом: второй вход считает оба списка и не выходит', () => {
    for (const src of [CHAT(), GROUPS()]) {
      const at = src.indexOf("const videoAssets = assets.filter((a) => a.type === 'video');");
      expect(at).toBeGreaterThan(0);
      const body = src.slice(at, at + 260);
      expect(body).toContain("const imageAssets = assets.filter((a) => a.type !== 'video');");
    }
    expect(CHAT()).toContain('if (imageAssets.length > 0) {');
    expect(GROUPS()).toContain('if (imageAssets.length > 0) {');
  });
});

describe('смешанный выбор доходит целиком', () => {
  it('оба списка считаются до того, как что-то отправится', () => {
    for (const [name, body] of Object.entries(BODIES())) {
      const video = body.indexOf("const videoAssets = res.assets.filter((a) => a.type === 'video');");
      const image = body.indexOf("const imageAssets = res.assets.filter((a) => a.type !== 'video');");
      const send = body.indexOf('await sendPickedVideos();');
      expect([name, image]).not.toEqual([name, -1]);
      expect([name, video < image && image < send]).toEqual([name, true]);
    }
  });

  it('отбор фотографий больше не стоит за выходом из ветки видео', () => {
    for (const [name, body] of Object.entries(BODIES())) {
      const send = body.indexOf('if (videoAssets.length > 0) await sendPickedVideos();');
      expect([name, send]).not.toEqual([name, -1]);
      // Между отправкой роликов и работой с фотографиями — ровно один выход,
      // и тот по пустому списку фотографий.
      const after = body.slice(send);
      expect([name, after]).toEqual([name, expect.stringContaining('if (imageAssets.length === 0) return;')]);
      expect([name, after.split('return;').length - 1]).toEqual([name, 1]);
    }
  });

  it('досрочные выходы отправки роликов заперты в своей форме', () => {
    for (const [name, body] of Object.entries(BODIES())) {
      const at = body.indexOf('const sendPickedVideos = async (): Promise<void> => {');
      expect([name, at]).not.toEqual([name, -1]);
      const end = body.indexOf('\n    };', at);
      expect([name, end > at]).toEqual([name, true]);
      // Все досрочные выходы обработчика — либо внутри формы (наружу они не
      // выходят), либо тот единственный, что стоит после неё по пустому
      // списку фотографий. Между началом тела и формой выходов нет вовсе.
      const outside = [...body.matchAll(/\breturn;/g)]
        .map((m) => m.index ?? 0)
        .filter((i) => i < at || i > end)
        .map((i) => body.slice(body.lastIndexOf('\n', i) + 1, body.indexOf('\n', i)).trim());
      expect([name, outside]).toEqual([
        name,
        ['if (res.canceled || res.assets.length === 0) return;', 'if (imageAssets.length === 0) return;'],
      ]);
    }
  });

  it('пачку больше не отменяет один большой ролик', () => {
    for (const [name, body] of Object.entries(BODIES())) {
      expect([name, body.includes('const tooLarge = videoAssets.find(')]).toEqual([name, false]);
      expect([name, body.includes('Alert.alert(OVERSIZE_TITLE.video')]).toEqual([name, false]);
      // Считается поштучно, как во втором входе.
      expect([name, body.includes("if (up.reason === 'oversize')")]).toEqual([name, true]);
    }
  });

  it('в переписке ролики без собеседника не пропадают молча', () => {
    const body = BODIES()['переписка'];
    const at = body.indexOf('const sendPickedVideos = async (): Promise<void> => {');
    expect(body.slice(at, at + 160)).toContain('if (!peerB64) { showError(NOT_READY_TEXT); return; }');
    // И прежнего условия, прятавшего ролики за `&& peerB64`, больше нет.
    expect(body).not.toContain('if (videoAssets.length > 0 && peerB64) {');
  });
});

describe('совет по слишком большому ролику не потерялся вместе с проверкой', () => {
  it('отчёт о пачке называет и предел, и что с этим делать', () => {
    const r = batchSendReport(
      { total: 1, sent: 0, oversize: 1, failed: 0, refused: 0 },
      'video',
      8 * 1024 * 1024,
    );
    expect(r).toContain('слишком большое');
    expect(r).toContain('Предел —');
    expect(r).toContain('Обрежьте видео или уменьшите качество.');
  });

  it('у фотографий совета нет — и выдумывать его не стали', () => {
    const r = batchSendReport(
      { total: 3, sent: 1, oversize: 2, failed: 0, refused: 0 },
      'photo',
      8 * 1024 * 1024,
    );
    expect(r).toContain('Отправлено фото: 1 из 3');
    expect(r).not.toContain('Обрежьте');
  });

  it('к чужой причине предел по-прежнему не приписывается', () => {
    const r = batchSendReport(
      { total: 2, sent: 0, oversize: 0, failed: 2, refused: 0 },
      'video',
      8 * 1024 * 1024,
    );
    expect(r).toContain('не загрузились');
    expect(r).not.toContain('Предел —');
    expect(r).not.toContain('Обрежьте');
  });
});
