import { readFileSync } from 'fs';
import { join } from 'path';
import { TAB_ORDER, stepTab } from '../tabOrder';

describe('порядок вкладок (v4.32.575)', () => {
  it('идёт по соседям и не заворачивается на краях', () => {
    expect(stepTab('feed', 1)).toBe('chat');
    expect(stepTab('chat', -1)).toBe('feed');
    expect(stepTab('profile', 1)).toBe('settings');
    expect(stepTab('settings', 1)).toBeNull();
    expect(stepTab('feed', -1)).toBeNull();
  });

  it('совпадает с порядком кнопок в панели — иначе свайп ходил бы не туда', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf8');
    const bar = [...src.matchAll(/tab === '(\w+)' \? styles\.tabActive/g)].map((m) => m[1]);
    expect(bar).toEqual([...TAB_ORDER]);
  });
});
