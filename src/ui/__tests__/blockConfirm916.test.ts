/**
 * О блокировке предупреждали тремя разными обещаниями — и все три неполные
 * (v4.32.916).
 *
 * Дефект. Одно и то же действие — «Заблокировать» — спрашивало по-разному в
 * четырёх местах:
 *
 *   • карточка человека: «Сообщения и звонки от этого человека будут
 *     отклонены.»
 *   • меню чата: «Сообщения будут отклонены.» — про звонки ни слова;
 *   • контакты, меню строки: ничего. Одно нажатие — запрет стоит;
 *   • контакты, лист «такой контакт уже есть»: тоже ничего.
 *
 * Цена. Две.
 *   • Обещание не покрывало половину последствий. Запрет двусторонний, и это
 *     написано в самом коде: feedService («заблокированным моя нода чужое не
 *     пересылает — блокировка двухсторонняя»), storyService и feedTransport
 *     отсеивают заблокированных из рассылки, callService молча отбивает
 *     входящий звонок. Человек, прочитавший «Сообщения будут отклонены»,
 *     соглашался ещё и на то, что его собственные посты и истории перестанут
 *     уходить, — и узнавал об этом не отсюда.
 *   • Там, где чаще всего нажимают, не спрашивали вовсе. В меню строки
 *     контакта «Заблокировать» стоит рядом с «Удалить», и «Удалить»
 *     переспрашивает, а «Заблокировать» — нет.
 *
 * Правка. Текст один на все места и лежит там же, где BLOCK_NOT_SAVED_ON и
 * BLOCK_NOT_SAVED_OFF, — в rateLimiter. Перечисляет он ровно то, что делает
 * код. Оба места в контактах теперь спрашивают так же, как чат и карточка.
 *
 * Снятие запрета не переспрашивает нигде: оно ничего не отнимает.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { BLOCK_CONFIRM_BODY, BLOCK_CONFIRM_TITLE, BLOCK_NOT_SAVED_OFF, BLOCK_NOT_SAVED_ON } from '../../core/security/rateLimiter';

const root = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const CHAT = read('src/ui/screens/ChatScreen.tsx');
const CONTACTS = read('src/ui/screens/ContactsScreen.tsx');
const PEEK = read('src/ui/components/UserProfilePeek.tsx');
const GROUPS = read('src/ui/screens/GroupsScreen.tsx');

/**
 * Текст без комментариев: правка сама цитирует прежнюю строку, и без этого
 * проверки «такого больше нет» ловили бы собственное объяснение.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('все четыре места с блокировкой на месте', () => {
    expect(CHAT).toContain("const blockLabel = isBlocked ? 'Разблокировать' : 'Заблокировать';");
    expect(CONTACTS.split("'Разблокировать' : 'Заблокировать'").length - 1).toBe(2);
    expect(PEEK).toContain('rateLimiter.blockContact(pub)');
  });

  it('вырезание комментариев не съедает код', () => {
    const chat = codeOnly(CHAT);
    expect(chat.length).toBeGreaterThan(CHAT.length / 2);
    expect(chat).toContain('rateLimiter.blockContact(peerB64)');
  });
});

describe('о блокировке предупреждают одинаково и целиком', () => {
  it('дом называет и звонки, и свою сторону запрета', () => {
    expect(BLOCK_CONFIRM_TITLE).toBe('Заблокировать?');
    expect(BLOCK_CONFIRM_BODY).toContain('звонки');
    expect(BLOCK_CONFIRM_BODY).toContain('посты и истории');
    expect(BLOCK_CONFIRM_BODY).toContain('двусторонняя');
  });

  it('чат больше не обещает только про сообщения', () => {
    expect(codeOnly(CHAT)).not.toContain('Сообщения будут отклонены.');
    expect(CHAT).toContain('Alert.alert(BLOCK_CONFIRM_TITLE, BLOCK_CONFIRM_BODY, [');
  });

  it('карточка человека берёт тот же текст, а не свой', () => {
    expect(codeOnly(PEEK)).not.toContain('Сообщения и звонки от этого человека будут отклонены.');
    expect(PEEK).toContain('Alert.alert(BLOCK_CONFIRM_TITLE, BLOCK_CONFIRM_BODY, [');
  });

  it('оба места в контактах теперь спрашивают', () => {
    expect(CONTACTS.split('Alert.alert(BLOCK_CONFIRM_TITLE, BLOCK_CONFIRM_BODY, [').length - 1).toBe(2);
    // И кнопка окрашена как отнимающая — так же, как в чате.
    expect(CONTACTS).toContain("style: alreadyBlocked ? 'default' : 'destructive',");
    expect(CONTACTS).toContain("style: isBlocked ? 'default' : 'destructive',");
  });

  it('своего текста про отклонение сообщений ни у кого не осталось', () => {
    for (const src of [CHAT, CONTACTS, PEEK]) {
      expect(codeOnly(src)).not.toContain('будут отклонены.');
    }
  });

  it('вопрос задают только на запрет, снятие проходит сразу', () => {
    // Симметрия здесь была бы данью форме: снятие запрета ничего не отнимает,
    // и переспрашивать о нём значит мешать исправить случайное нажатие.
    expect(CONTACTS).toContain('if (alreadyBlocked) { run(); return; }');
    expect(CONTACTS).toContain('if (isBlocked) { run(); return; }');
  });
});

describe('до правки было верно и осталось верно', () => {
  it('снятие запрета в чате идёт тем же путём, что и раньше', () => {
    expect(CHAT).toContain("Alert.alert('AirChat', ok ? 'Разблокировано' : BLOCK_NOT_SAVED_OFF);");
  });

  it('отказ записи доходит теми же словами', () => {
    expect(BLOCK_NOT_SAVED_ON).toBe(
      'Заблокировано, но запись не удалась — после перезапуска запрет пропадёт.'
    );
    expect(BLOCK_NOT_SAVED_OFF).toBe(
      'Разблокировано, но запись не удалась — после перезапуска запрет вернётся.'
    );
  });

  it('удаление контакта переспрашивает, как и раньше', () => {
    expect(CONTACTS).toContain("Alert.alert(\n              'Удалить контакт?',");
  });

  it('бан в группе — другое дело и своим текстом остался', () => {
    // Там запрещают читать и писать в одной группе, а не связь между людьми.
    expect(GROUPS).toContain("'Не сможет читать и писать в группу, вернуть — /unban.'");
  });
});
