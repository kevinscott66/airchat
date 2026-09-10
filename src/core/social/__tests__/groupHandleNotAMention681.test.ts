/**
 * v4.32.681: адрес группы не участвует в разрешении упоминаний.
 *
 * У адреса группы нет реестра: его ставит администратор и он едет конвертом
 * 'meta'. Если такой адрес начнёт разрешаться там, где ищут ЧЕЛОВЕКА по
 * @имени, канал, назвавшийся именем живого собеседника, будет перехватывать
 * адресованные тому упоминания — а человек, нажимая на @имя в чужом тексте,
 * попадёт не туда, куда рассчитывал.
 *
 * Проверка двойная: поведение (адрес группы не находится среди контактов) и
 * форма модуля (он вообще не знает про группы).
 */
import fs from 'fs';
import path from 'path';
import { lookupMentionAmong, contactCandidates } from '../mentionLookup';
import type { Contact } from '../contacts';

const PUB = `${'A'.repeat(43)}=`;

function contact(over: Partial<Contact> = {}): Contact {
  return {
    peerPublicKey: PUB,
    displayName: 'Рита',
    peerName: 'Рита',
    peerUsername: 'margarita',
    ...over,
  } as Contact;
}

describe('адрес группы не разрешается как упоминание человека', () => {
  it('строка, совпадающая с адресом канала, среди контактов не находится', () => {
    const list = [contact()];
    // ПРОВЕРКА НЕ ПУСТАЯ: настоящий юзернейм контакта по-прежнему находится.
    expect(lookupMentionAmong('margarita', list)).toMatchObject({ status: 'found', peerPubB64: PUB });
    expect(lookupMentionAmong('aircafe', list)).toEqual({ status: 'none' });
  });

  it('кандидаты строятся только из контактов и только из трёх их полей', () => {
    const cands = contactCandidates([contact({ displayName: 'Рита', peerName: 'Margo' })]);
    expect(cands).toHaveLength(2);
    for (const c of cands) expect(c.pub).toBe(PUB);
  });

  it('модуль упоминаний ничего не знает про группы и их адреса', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'mentionLookup.ts'), 'utf8');
    // ПРОВЕРКА НЕ ПУСТАЯ: файл прочитан и это тот самый модуль.
    expect(src).toContain('export function lookupMentionAmong');
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      "import { listContactsFor, type Contact } from './contacts';",
      "import { resolveMention } from './mentionResolve';",
    ]);
    expect(src).not.toContain('groupHandle');
    expect(src).not.toContain('FROM group' + 's');
  });
});
