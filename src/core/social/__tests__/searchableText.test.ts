/**
 * Поиск ищет по видимому тексту, а не по служебной нагрузке.
 *
 * До v4.32.239 запросом «cid», «lat», «http» или «voice» находилось каждое
 * вложение в переписке, потому что сравнение шло с сырой колонкой `text`.
 */

import { searchableText, matchesSearch } from '../searchableText';

describe('searchableText', () => {
  it('обычный текст проходит насквозь', () => {
    expect(searchableText('привет, как дела')).toBe('привет, как дела');
    expect(searchableText('')).toBe('');
  });

  it('служебные поля вложений не ищутся', () => {
    // Ровно те подстроки, которые давали ложные попадания.
    expect(matchesSearch('\x01voice:{"u":"https://ntfy.sh/abc","k":"KEY"}', 'https')).toBe(false);
    expect(matchesSearch('\x0agif:https://media.giphy.com/x.gif', 'giphy')).toBe(false);
    expect(matchesSearch('\x0cliveloc:{"lat":59.9}', 'lat')).toBe(false);
    expect(matchesSearch('\x06doc:{"name":"отчёт.pdf","size":10,"cid":"QmABC"}', 'qmabc')).toBe(false);
    expect(matchesSearch('\x07loc:{"lat":59.9,"lon":30.3,"label":"Невский"}', 'lon')).toBe(false);
  });

  it('видимые поля вложений ищутся', () => {
    expect(matchesSearch('\x06doc:{"name":"отчёт.pdf","size":10,"cid":"QmABC"}', 'отчёт')).toBe(true);
    expect(matchesSearch('\x07loc:{"lat":59.9,"lon":30.3,"label":"Невский"}', 'невский')).toBe(true);
    expect(matchesSearch('\x05contact:{"name":"Аня","pub":"BASE64"}', 'аня')).toBe(true);
    expect(matchesSearch('\x04poll:{"question":"Когда встреча?","options":["Утром","Вечером"]}', 'встреча')).toBe(true);
    expect(matchesSearch('\x04poll:{"question":"Когда встреча?","options":["Утром","Вечером"]}', 'вечером')).toBe(true);
  });

  it('ключ контакта не утекает в результаты поиска', () => {
    // pub — это публичный ключ; на экране его нет, искать по нему нечего.
    expect(matchesSearch('\x05contact:{"name":"Аня","pub":"BASE64KEY"}', 'base64key')).toBe(false);
  });

  it('системная строка ищется без управляющего префикса', () => {
    expect(searchableText('\x0bsys:Исчезающие сообщения выключены')).toBe('Исчезающие сообщения выключены');
    expect(matchesSearch('\x0bsys:Аня вышла из группы', 'sys')).toBe(false);
  });

  it('одноразовое сообщение не ищется никогда', () => {
    // Подпись показывается один раз и стирается — поиск не должен её воскрешать.
    expect(searchableText('\x09vo:секретная подпись')).toBe('');
  });

  it('в пересылке ищется и автор, и содержимое', () => {
    expect(matchesSearch('\x08fwd:Аня\nпривет', 'аня')).toBe(true);
    expect(matchesSearch('\x08fwd:Аня\nпривет', 'привет')).toBe(true);
    // Вложенный конверт разбирается рекурсивно, а не ищется сырым.
    expect(matchesSearch('\x08fwd:Аня\n\x06doc:{"name":"смета.xlsx","size":1,"cid":"Qm1"}', 'смета')).toBe(true);
    expect(matchesSearch('\x08fwd:Аня\n\x06doc:{"name":"смета.xlsx","size":1,"cid":"Qm1"}', 'qm1')).toBe(false);
  });

  it('служебные конверты не ищутся', () => {
    for (const c of ['\x02grp:{}', '\x03grpr:{}', '\x0egctl:{}', '\x0freact:{}', '\x10dmpin:{}', '\x11dis:{}', '\x12pres:{}']) {
      expect(searchableText(c)).toBe('');
    }
  });

  it('битая нагрузка от чужого клиента не роняет поиск', () => {
    expect(searchableText('\x04poll:не json')).toBe('');
    expect(searchableText('\x06doc:[1,2,3]')).toBe('');
    expect(searchableText('\x05contact:null')).toBe('');
    expect(matchesSearch('привет', '')).toBe(false);
  });
});
