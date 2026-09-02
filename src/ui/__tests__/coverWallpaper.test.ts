import { coverWallpaperFor, WALLPAPER_MESHES, meshById } from '../wallpapers';

describe('coverWallpaperFor (v4.32.540)', () => {
  it('всегда даёт существующий пресет — обложка не может остаться пустой', () => {
    for (const seed of ['', 'AC-00000-00000', 'AC-ZZZZZ-ZZZZZ', 'did:key:z6Mk', 'x']) {
      const w = coverWallpaperFor(seed);
      expect(w.type).toBe('mesh');
      expect(meshById(w.value)).not.toBeNull();
    }
  });

  it('один и тот же человек открывается одинаково', () => {
    expect(coverWallpaperFor('AC-4KQ7T-9WXM2')).toEqual(coverWallpaperFor('AC-4KQ7T-9WXM2'));
  });

  it('разводит зёрна по всему набору, а не сажает всех на один пресет', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i += 1) seen.add(coverWallpaperFor(`AC-SEED-${i}`).value);
    expect(seen.size).toBe(WALLPAPER_MESHES.length);
  });
});
