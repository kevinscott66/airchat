/** Regression coverage for the cross-device voice delivery contract. */
import fs from 'fs';
import path from 'path';

const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', '..', 'screens', file), 'utf8');

describe('voice delivery guards', () => {
  it('DMs never persist a remote voice without an encrypted blob descriptor', () => {
    const source = read('ChatScreen.tsx');
    expect(source).toContain("if (!blob) throw new Error('Голосовое не загрузилось. Проверьте соединение и повторите.')");
    expect(source).not.toContain('makeVoiceText(result.uri, result.durationMs, blob ?? undefined)');
    expect(source).toContain('deleteCachedFileUris([result.uri])');
  });

  it('groups use the same all-or-nothing delivery rule', () => {
    const source = read('GroupsScreen.tsx');
    expect(source).toContain("if (!blob) throw new Error('Голосовое не загрузилось. Проверьте соединение и повторите.')");
    expect(source).not.toContain('makeVoiceText(r.uri, r.durationMs, blob ?? undefined)');
    expect(source).toContain('deleteCachedFileUris([r.uri])');
  });
});
