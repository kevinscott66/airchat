/**
 * Разделы профиля разворачиваются в самой карточке (v4.32.577).
 *
 * Проверка по исходнику, а не по отрисовке: карточка — большой React-компонент
 * без своего рендер-теста, а утверждение здесь ровно одно и оно структурное —
 * «раздел показывается на месте, а не окном поверх профиля». Именно это
 * ломалось дважды: сперва плашки уводили в галерею переписки, потом
 * «Избранное» уводило в переписку и закрывало карточку.
 *
 * Второе утверждение — про один список на два места. Полосы `SharedMediaPane`
 * и `ProfilePostsPane` живут в тех же файлах, что и полноэкранные окна, и
 * окна показывают именно их: копия «файлов переписки» разошлась бы с
 * оригиналом на первой же правке.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { hubSections } from '../profileHubModel';

const UI = join(__dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(UI, ...p), 'utf8');

const PEEK = (): string => read('components', 'UserProfilePeek.tsx');
const CHAT_MEDIA = (): string => read('components', 'modals', 'chat', 'ChatSharedMediaModal.tsx');
const POSTS = (): string => read('components', 'modals', 'profile', 'ProfilePostsModal.tsx');

const FACTS = {
  isSelf: false,
  inContacts: true,
  hasContactRecord: true,
  blocked: false,
  muted: false,
  copyGuard: false,
  copyGuardByPeer: false,
  disappearMs: null,
  reported: false,
  canOpenChat: true,
  inChat: false,
};

describe('разделы профиля', () => {
  it('файлы, музыка, голосовые и ссылки — свои разделы, а не вкладки внутри «Медиа»', () => {
    const ids = hubSections(FACTS).map((s) => s.id);
    for (const id of ['files', 'music', 'voice', 'links'] as const) {
      expect(ids).toContain(id);
    }
  });

  it('нажатие на раздел разворачивает его в карточке, а не открывает окно', () => {
    const src = PEEK();
    expect(src).toContain('setOpenSection((prev) => (prev === id ? null : id));');
    // Прежнее поведение: раздел уводил из карточки и закрывал её.
    expect(src).not.toContain("onOpenChat?.(resolved.pubB64, displayName, 'starred');\n      onClose();");
  });

  it('карточка рисует содержимое разделов сама', () => {
    const src = PEEK();
    for (const pane of ['<SharedMediaPane', '<ProfilePostsPane', '<ProfileStarredPane']) {
      expect(src).toContain(pane);
    }
  });

  it('полноэкранные окна показывают те же полосы, а не свою копию списка', () => {
    expect(CHAT_MEDIA()).toContain('<SharedMediaPane');
    expect(POSTS()).toContain('<ProfilePostsPane');
  });

  it('в карточке список обрезан и обрезка названа словами', () => {
    const src = PEEK();
    expect(src).toContain('limit={PANE_LIMIT}');
    expect(CHAT_MEDIA()).toContain('Показать всё');
  });
});
