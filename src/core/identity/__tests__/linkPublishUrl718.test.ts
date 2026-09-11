/**
 * Куда ведёт кнопка на шаге подтверждения (v4.32.718).
 *
 * Человек сообщил: «ссылка на этапе подтверждения гитхаб ведёт на какое-то
 * стороннее репо». Так и было. Кнопка открывала голый `gist.github.com` —
 * витрину «Discover gists», ленту чужих публикаций. На шаге, где приложение
 * просит опубликовать СВОЮ подписанную строку, это худший из возможных
 * адресов: он выглядит как промах приложения и ничего не даёт сделать.
 *
 * Здесь заперты обе стороны: адрес публикации ведёт на форму создания, и он
 * никогда не разбирается как адрес доказательства — «куда идти писать» и
 * «что вставить обратно» не должны совпадать даже случайно.
 */
import fs from 'fs';
import path from 'path';

import { parseGistId, parseTweetUrl, publishUrl } from '../linkPlatform';

const SHEET = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'components', 'modals', 'profile', 'LinkProofSheet.tsx'),
  'utf8',
);

/** Комментарий не должен уметь пройти проверку вместо кода. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

describe('адрес публикации (v4.32.718)', () => {
  it('GitHub ведёт на форму создания gist', () => {
    expect(publishUrl('github')).toBe('https://gist.github.com/new');
  });

  it('ПОВОД ДЛЯ ПРАВКИ ЖИВ: голая витрина gist больше не адрес публикации', () => {
    // Именно этот адрес открывал ленту чужих публикаций.
    expect(publishUrl('github')).not.toBe('https://gist.github.com/');
    expect(publishUrl('github')).not.toBe('https://gist.github.com');
  });

  it('X ведёт на форму записи, а не на главную', () => {
    expect(publishUrl('x')).toBe('https://x.com/compose/post');
    expect(publishUrl('x')).not.toBe('https://x.com/');
  });

  it('оба адреса — обычные https', () => {
    for (const p of ['github', 'x'] as const) {
      expect(publishUrl(p).startsWith('https://')).toBe(true);
    }
  });

  it('адрес публикации не разбирается как адрес доказательства', () => {
    expect(parseGistId(publishUrl('github'))).toBeNull();
    expect(parseTweetUrl(publishUrl('x'))).toBeNull();
  });

  it('лист берёт адрес из общего правила, а не хранит свой', () => {
    const body = codeOnly(SHEET);
    expect(body).toContain('publishUrl(platform)');
    // Голого адреса витрины в листе не осталось ни в каком виде.
    expect(body).not.toContain("'https://gist.github.com/'");
    expect(body).not.toContain('const PUBLISH_URL');
  });

  it('кнопка обещает то, что делает', () => {
    const body = codeOnly(SHEET);
    expect(body).toContain("github: 'Создать gist'");
    expect(body).not.toContain('Открыть {label}');
  });
});
