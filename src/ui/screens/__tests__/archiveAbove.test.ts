/**
 * v4.32.584: архив должен быть НАД списком.
 *
 * Проверки структурные — читаем исходник экранов. Отрисовать эти экраны в
 * тесте нельзя: они тянут за собой SQLite, криптографию и половину нативных
 * модулей. А регрессия здесь тихая: кто-нибудь снова переложит вход в архив
 * в подвал FlatList, всё соберётся, и найдёт его только тот, кто пролистает
 * сотню чатов до конца.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');

/** Тело JSX-пропа `name={...}` — от знака равенства до следующего пропа того же уровня. */
function propBlock(src: string, name: string): string {
  const start = src.indexOf(`${name}={`);
  if (start < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

describe('архив выше списка', () => {
  it('чаты: вход в архив лежит в шапке списка', () => {
    const src = read('ChatListScreen.tsx');
    expect(src).not.toContain('ListFooterComponent');
    const header = propBlock(src, 'ListHeaderComponent');
    expect(header).toContain('s.archiveRow');
    expect(header).toContain('setShowArchived(true)');
  });

  it('группы: раскладка «Архивные (N)» лежит в шапке списка', () => {
    const src = read('GroupsScreen.tsx');
    // Подвал в файле есть — но у списка забаненных участников, а не у групп.
    expect(src).not.toContain('ListFooterComponent={archivedGroups');
    expect(src).toContain('ListHeaderComponent={archivedGroups.length > 0 ? (');
    const header = propBlock(src, 'ListHeaderComponent');
    expect(header).toContain('Архивные (');
  });

  it('чаты: список строится общей сборкой, а не заново внутри экрана', () => {
    const src = read('ChatListScreen.tsx');
    expect(src).toContain('buildChatListRows');
    expect(src).not.toContain('convMap');
  });
});
