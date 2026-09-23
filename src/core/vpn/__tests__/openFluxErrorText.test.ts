/**
 * Текст ошибки ядра не выносит наружу ссылку на документ (v4.32.723).
 *
 * Проверяется то, ради чего модуль и написан: что бы ядро ни напечатало, в
 * журнал и на экран не попадает ни один адрес — ни тот, что мы ядру дали, ни
 * его переписанный вид. Остальное (причина отказа словами) должно уцелеть,
 * иначе запись в журнале перестанет отличать «документ закрыт» от «нет сети».
 */
import { openFluxErrorText } from '../openFluxErrorText';

describe('текст ошибки ядра OpenFlux', () => {
  it('убирает ссылку на документ, оставляя причину', () => {
    const out = openFluxErrorText(new Error('doc unreachable: https://disk.yandex.ru/edit/d/SECRET-KEY-1234'));
    expect(out).not.toContain('SECRET-KEY-1234');
    expect(out).not.toContain('disk.yandex.ru');
    expect(out).toContain('doc unreachable');
  });

  it('убирает и переписанный ядром адрес — конечную точку API с ключом', () => {
    const out = openFluxErrorText(new Error('POST https://cloud-api.yandex.net/v1/disk/resources?path=SECRET failed with 403'));
    expect(out).not.toContain('SECRET');
    expect(out).toContain('failed with 403');
  });

  it('убирает каждый адрес, а не только первый', () => {
    const out = openFluxErrorText(new Error('redirect https://a.example/one -> wss://b.example/two'));
    expect(out).not.toContain('a.example');
    expect(out).not.toContain('b.example');
  });

  it('не-Error тоже чистит: ядро бросает и строкой', () => {
    expect(openFluxErrorText('fail at https://disk.yandex.ru/edit/d/KEY')).not.toContain('KEY');
  });

  it('молчаливое падение остаётся сведением, а не пустотой', () => {
    expect(openFluxErrorText(new Error(''))).not.toBe('');
  });

  it('дамп вместо сообщения обрезает', () => {
    expect(openFluxErrorText(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(301);
  });

  it('обычный текст без адресов не портит', () => {
    expect(openFluxErrorText(new Error('editor disabled'))).toBe('editor disabled');
  });
});
