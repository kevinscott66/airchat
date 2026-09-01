/**
 * v4.32.569. Личное сообщение с фотографиями уходило собеседнику даже тогда,
 * когда не загрузилась ни одна из них: длина списка ссылок ни разу не
 * сравнивалась с числом выбранных файлов.
 */
import fs from 'fs';
import path from 'path';

import { decideMediaSend, tallyMediaUploads } from '../mediaSendReport';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const MESSAGING = (): string => read('core', 'social', 'messaging.ts');
const CHAT = (): string => read('ui', 'screens', 'ChatScreen.tsx');
const MODULE = (): string => read('core', 'media', 'mediaSendReport.ts');

const ok = { ok: true } as const;
const big = { ok: false, reason: 'oversize' } as const;
const bad = { ok: false, reason: 'failed' } as const;

describe('tallyMediaUploads', () => {
  it('считает удачные и обе причины отказа', () => {
    expect(tallyMediaUploads([ok, big, bad, ok])).toEqual({ total: 4, sent: 2, oversize: 1, failed: 1 });
  });

  it('пустой выбор — пустой счёт', () => {
    expect(tallyMediaUploads([])).toEqual({ total: 0, sent: 0, oversize: 0, failed: 0 });
  });

  it('незнакомая причина считается обычной неудачей, а не теряется', () => {
    const weird = { ok: false, reason: 'quantum' as unknown as 'failed' };
    expect(tallyMediaUploads([weird])).toEqual({ total: 1, sent: 0, oversize: 0, failed: 1 });
    expect(tallyMediaUploads([{ ok: false }])).toEqual({ total: 1, sent: 0, oversize: 0, failed: 1 });
  });
});

describe('decideMediaSend', () => {
  it('текстовое сообщение без вложений уходит молча', () => {
    expect(decideMediaSend(tallyMediaUploads([]))).toEqual({ kind: 'send', warn: null });
  });

  it('всё загрузилось — уходит молча', () => {
    expect(decideMediaSend(tallyMediaUploads([ok, ok]))).toEqual({ kind: 'send', warn: null });
  });

  it('не загрузилось ни одного — сообщение не отправляется', () => {
    const v = decideMediaSend(tallyMediaUploads([bad]));
    expect(v.kind).toBe('abort');
    if (v.kind === 'abort') expect(v.text).toBe('Не удалось загрузить файл — сообщение не отправлено.');
  });

  it('единственный слишком большой файл назван своей причиной', () => {
    const v = decideMediaSend(tallyMediaUploads([big]));
    if (v.kind !== 'abort') throw new Error('ожидался отказ');
    expect(v.text).toBe('Файл слишком большой — сообщение не отправлено.');
  });

  it('все файлы слишком большие — множественное число', () => {
    const v = decideMediaSend(tallyMediaUploads([big, big, big]));
    if (v.kind !== 'abort') throw new Error('ожидался отказ');
    expect(v.text).toBe('Файлы слишком большие — сообщение не отправлено.');
  });

  it('смешанный отказ не выдаётся за превышение размера', () => {
    const v = decideMediaSend(tallyMediaUploads([big, bad]));
    if (v.kind !== 'abort') throw new Error('ожидался отказ');
    expect(v.text).toBe('Не удалось загрузить файлы — сообщение не отправлено.');
  });

  it('ушла часть — сообщение отправляется, но человеку говорят сколько', () => {
    const v = decideMediaSend(tallyMediaUploads([ok, bad, bad]));
    expect(v).toEqual({ kind: 'send', warn: 'Отправлено вложений: 1 из 3 — остальные не загрузились.' });
  });

  it('часть пропала по размеру — причина названа', () => {
    const v = decideMediaSend(tallyMediaUploads([ok, big]));
    expect(v).toEqual({ kind: 'send', warn: 'Отправлено вложений: 1 из 2 — остальные слишком большие.' });
  });

  it('обе причины сразу — говорится про обе', () => {
    const v = decideMediaSend(tallyMediaUploads([ok, big, bad]));
    expect(v).toEqual({
      kind: 'send',
      warn: 'Отправлено вложений: 1 из 3 — остальные слишком большие или не загрузились.',
    });
  });

  it('ни один текст отказа не остаётся пустым', () => {
    for (const results of [[bad], [big], [bad, big], [big, big], [ok, bad], [ok, big], [ok, big, bad]]) {
      const v = decideMediaSend(tallyMediaUploads(results));
      const text = v.kind === 'abort' ? v.text : v.warn;
      expect(typeof text).toBe('string');
      expect((text ?? '').length).toBeGreaterThan(10);
    }
  });
});

describe('отправка личного сообщения сверяет число вложений', () => {
  it('причина отказа больше не превращается в null внутри загрузки', () => {
    const s = MESSAGING();
    expect(s).toContain('private async uploadMediaFromUri(uri: string, targetDid?: string): Promise<MediaUploadResult>');
    expect(s).not.toContain('return res.ok ? res.cid : null;');
  });

  it('приговор считается по всем результатам, а не по длине списка ссылок', () => {
    const s = MESSAGING();
    expect(s).toContain('const verdict = decideMediaSend(tallyMediaUploads(results));');
    expect(s).toContain('if (r.ok) mediaCids.push(r.cid);');
  });

  it('сообщение без единого вложения не отправляется, и это исключение', () => {
    const s = MESSAGING();
    const at = s.indexOf("if (verdict.kind === 'abort') {");
    expect(at).toBeGreaterThan(-1);
    const branch = s.slice(at, s.indexOf('\n      }\n', at));
    expect(branch).toContain("log.warn('dm_media_all_failed'");
    expect(branch).toContain('throw new Error(verdict.text);');
  });

  it('частичная отправка доходит до человека, а не только до журнала', () => {
    const s = MESSAGING();
    expect(s).toContain("log.warn('dm_media_partial'");
    expect(s).toContain("code: 'MEDIA_PARTIAL',");
    expect(s).toContain('message: verdict.warn,');
  });

  it('экран переписки называет причину отказа, а не молчит', () => {
    expect(CHAT()).toContain("showError(userErrorText(e, 'Не удалось отправить сообщение'));");
  });
});

describe('форма модуля', () => {
  it('модуль без импортов — счёт и тексты проверяются отдельно от сети', () => {
    expect(MODULE()).not.toMatch(/^import /m);
  });
});
