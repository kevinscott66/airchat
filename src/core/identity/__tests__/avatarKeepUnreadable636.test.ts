/**
 * Уборка аватаров не сносит лицо живого профиля из-за нечитаемой записи
 * (v4.32.636).
 *
 * sweepAvatarFiles удаляет всё, чего нет в списке «оставить». Список собирался
 * строковым чтением, а оно отвечает null и на «аватара нет», и на «запись не
 * открылась нашим ключом». Второе выдавалось за первое: файл живого профиля не
 * попадал в список и уходил с диска навсегда — при том что байты записи ещё
 * могли открыться верным ключом.
 */
const mockKv: Record<string, string> = {};
const mockUnreadable = new Set<string>();

jest.mock('../../storage/local', () => {
  const cell = (k: string) => {
    if (mockUnreadable.has(k)) return { state: 'unreadable' as const };
    const v = mockKv[k];
    return v == null ? { state: 'absent' as const } : { state: 'plain' as const, text: v };
  };
  return {
    __kv: mockKv,
    kvGetSecretCell: jest.fn(async (k: string) => cell(k)),
    kvGetSecretCellScoped: jest.fn(async (pid: number, k: string) => {
      const own = cell(`p${pid}:${k}`);
      return own.state === 'absent' ? cell(k) : own;
    }),
  };
});
jest.mock('../../logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { AVATAR_NAME_KEY, AvatarKeepUnknownError, collectAvatarsToKeep } from '../avatarKeep';

const KEY = AVATAR_NAME_KEY;

beforeEach(() => {
  for (const k of Object.keys(mockKv)) delete mockKv[k];
  mockUnreadable.clear();
});

describe('список «оставить» различает «аватара нет» и «не прочиталось»', () => {
  it('ПРОВЕРКА НЕ ПУСТАЯ: читаемые записи собираются в список', async () => {
    mockKv[`p1:${KEY}`] = 'avatar_1.jpg';
    mockKv[`p2:${KEY}`] = 'avatar_2.jpg';
    expect(await collectAvatarsToKeep([1, 2])).toEqual(['avatar_1.jpg', 'avatar_2.jpg']);
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: профиль без аватара просто ничего не добавляет', async () => {
    mockKv[`p1:${KEY}`] = 'avatar_1.jpg';
    expect(await collectAvatarsToKeep([1, 2])).toEqual(['avatar_1.jpg']);
  });

  it('нечитаемая запись профиля срывает сбор, а не пропускается молча', async () => {
    mockKv[`p1:${KEY}`] = 'avatar_1.jpg';
    mockUnreadable.add(`p2:${KEY}`);
    await expect(collectAvatarsToKeep([1, 2])).rejects.toBeInstanceOf(AvatarKeepUnknownError);
  });

  it('нечитаемая общая запись первого профиля — тоже срыв', async () => {
    mockKv[`p1:${KEY}`] = 'avatar_1.jpg';
    mockUnreadable.add(KEY);
    await expect(collectAvatarsToKeep([1])).rejects.toBeInstanceOf(AvatarKeepUnknownError);
  });

  it('пустой перечень профилей не выдаётся за «оставить нечего»', async () => {
    await expect(collectAvatarsToKeep([])).rejects.toBeInstanceOf(AvatarKeepUnknownError);
  });
});

describe('удаление профиля собирает список именно так', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'profileManager.ts'),
    'utf8',
  );
  const body = source
    .slice(source.indexOf('private async sweepOrphanedAvatars('))
    .slice(0, 700)
    .replace(/^\s*\/\/.*$/gm, '');

  it('ПРОВЕРКА НЕ ПУСТАЯ: уборка файлов по-прежнему вызывается', () => {
    expect(source).toContain('private async sweepOrphanedAvatars(');
    expect(body).toContain('sweepAvatarFiles(keep)');
  });

  it('список берётся у collectAvatarsToKeep, а не строковым чтением', () => {
    expect(body).toContain('collectAvatarsToKeep');
    expect(body).not.toContain('kvGetSecretScoped');
    expect(body).not.toContain("kvGetSecret(");
  });
});
