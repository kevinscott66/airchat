/**
 * Разрушающее действие не говорило, что случится (v4.32.908).
 *
 * Три места, одна беда: человека спрашивали «удалить?», не сказав, ЧТО именно
 * он потеряет и у кого. Про необратимость в приложении уже умеют говорить —
 * `deletePostSelfMsg` и `deletePostOtherMsg` в ленте написаны как надо, — и
 * ровно на их фоне эти три видны.
 *
 * 1. Сторис. Подтверждения не было вовсе: «🗑 Удалить сторис» стояло ПЕРВЫМ
 *    пунктом меню и стирало в один палец. Вернуть нечем — уходит и строка, и
 *    файл снимка. А конверт к этому времени разослан личными сообщениями
 *    каждому контакту (storyService), и у них копия остаётся, пока не истечёт
 *    сама: местное удаление её не отзывает. Человек, стирающий сторис второпях
 *    («не то выложил»), уверен в обратном.
 *
 * 2. Комментарий. `Alert.alert(t('feed.deleteCommentConfirm'), undefined, …)` —
 *    тело просто `undefined`. Удаление при этом рассылает тумбстоун
 *    (deleteFeedComment), то есть комментарий пропадает и у получивших.
 *
 * 3. Запланированное сообщение. Заголовок «Удалить?» не называл предмет, а
 *    телом стоял второй вопрос — «Отменить запланированное сообщение?».
 *    Два вопроса подряд об одном и том же и ни слова о том, что текст
 *    стирается вместе со строкой.
 *
 * Правка: у каждого — заголовок, называющий предмет, и тело, называющее
 * последствие. Экраны в jest не поднимаются, поэтому проверяется исходник.
 */
import fs from 'fs';
import path from 'path';

const UI = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(UI, rel), 'utf8');

/** Исходник без строк-комментариев: пояснение цитирует те же строки. */
const bare = (rel: string): string =>
  read(rel)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join('\n');

const RU = (): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(UI, '..', 'i18n', 'ru.json'), 'utf8'));

describe('у разрушающего действия есть предмет и последствие', () => {
  test('сторис: удаление спрашивает, а не стирает сразу', () => {
    const s = bare('components/StoriesRow.tsx');
    expect(s).toContain("'Удалить сторис?',");
    expect(s).toContain("{ text: 'Отмена', style: 'cancel' },");
    // Пункт меню больше не зовёт deleteStory сам — он открывает вопрос.
    const menuItem = s.slice(s.indexOf("text: '🗑 Удалить сторис',"));
    const confirm = menuItem.indexOf('Удалить сторис?');
    const call = menuItem.indexOf('deleteStory(story.id, ownerProfileId)');
    expect(confirm).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(confirm);
  });

  test('сторис: тело называет обе потери и чужие копии', () => {
    const s = bare('components/StoriesRow.tsx');
    expect(s).toContain(
      "'У вас она исчезнет вместе со снимком. У контактов, которые её уже получили, останется, пока не истечёт сама. Отменить нельзя.',",
    );
  });

  test('комментарий: тела больше не undefined', () => {
    const s = bare('screens/FeedScreen.tsx');
    expect(s).toContain("Alert.alert(t('feed.deleteCommentConfirm'), t('feed.deleteCommentMsg'), [");
    expect(s).not.toContain("Alert.alert(t('feed.deleteCommentConfirm'), undefined, [");
  });

  test('комментарий: текст говорит про чужие копии, а не только про свои', () => {
    const feed = RU().feed;
    expect(feed.deleteCommentMsg).toBe(
      'Комментарий будет удалён у вас и у всех, кто его получил. Отменить нельзя.',
    );
  });

  test('запланированное: заголовок называет предмет, тело — последствие', () => {
    const s = bare('components/modals/shared/ScheduledListModal.tsx');
    expect(s).toContain("'Удалить запланированное сообщение?',");
    expect(s).toContain(
      "'Оно не уйдёт в назначенное время, а его текст удалится. Отменить нельзя.',",
    );
    expect(s).not.toContain("Alert.alert('Удалить?', 'Отменить запланированное сообщение?', [");
  });

  test('ни одного вопроса вместо тела не осталось', () => {
    // Тело подтверждения отвечает, а не спрашивает: второй вопрос подряд
    // человек читает как «я не расслышал» и жмёт наугад.
    for (const rel of [
      'components/StoriesRow.tsx',
      'components/modals/shared/ScheduledListModal.tsx',
    ]) {
      expect(bare(rel)).not.toContain("'Удалить?'");
    }
  });

  test('во всём src/ui больше нет Alert.alert с телом undefined', () => {
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(name)) continue;
        const src = fs
          .readFileSync(full, 'utf8')
          .split('\n')
          .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
          .join('\n');
        if (/Alert\.alert\([^;]*?,\s*undefined\s*,/.test(src)) {
          offenders.push(path.relative(UI, full));
        }
      }
    };
    walk(UI);
    // Меню StoriesRow — не вопрос, а список действий: заголовка «Сторис» ему
    // хватает, и тело у него отсутствует намеренно.
    expect(offenders).toEqual(['components/StoriesRow.tsx']);
  });
});

describe('до правки было верно и осталось верно', () => {
  test('сторис по-прежнему сообщает о неудавшемся удалении', () => {
    const s = bare('components/StoriesRow.tsx');
    expect(s).toContain("showError('Не удалось удалить сторис.');");
    expect(s).toContain("log.warn('ui_story_delete_failed', { err: rawErrorText(e) });");
  });

  test('сторис по-прежнему закрывает просмотрщик только после удачи', () => {
    expect(bare('components/StoriesRow.tsx')).toContain('.then(onClose)');
  });

  test('у публикации оба текста последствий на месте', () => {
    const feed = RU().feed;
    expect(feed.deletePostSelfMsg).toContain('Отменить нельзя.');
    expect(feed.deletePostOtherMsg).toContain('только у вас на устройстве');
  });

  test('запланированное по-прежнему удаляет ту самую строку', () => {
    expect(bare('components/modals/shared/ScheduledListModal.tsx')).toContain(
      "{ text: 'Удалить', style: 'destructive', onPress: () => onDelete(item.id) },",
    );
  });

  test('заголовок списка запланированных не менялся', () => {
    // Термин в вопросе взят из него же: человек смотрит на «Запланированные».
    expect(bare('components/modals/shared/ScheduledListModal.tsx')).toContain('>Запланированные<');
  });
});
