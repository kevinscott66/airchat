import { isMentionOf } from '../mentions';

describe('isMentionOf', () => {
  it('находит упоминание независимо от регистра', () => {
    expect(isMentionOf('привет @Аня, зайди', 'Аня')).toBe(true);
    expect(isMentionOf('привет @аня', 'АНЯ')).toBe(true);
    expect(isMentionOf('@Bob ping', 'bob')).toBe(true);
  });

  it('не срабатывает на более длинном имени', () => {
    // Ровно тот случай, ради которого нужны границы слова.
    expect(isMentionOf('@анна привет', 'аня')).toBe(false);
    expect(isMentionOf('@bobby', 'bob')).toBe(false);
    expect(isMentionOf('@bob_smith', 'bob')).toBe(false);
    expect(isMentionOf('@bob2', 'bob')).toBe(false);
  });

  it('знак препинания после имени границу не ломает', () => {
    expect(isMentionOf('@bob, привет', 'bob')).toBe(true);
    expect(isMentionOf('спроси у @bob.', 'bob')).toBe(true);
    expect(isMentionOf('@bob', 'bob')).toBe(true);
    expect(isMentionOf('(@bob)', 'bob')).toBe(true);
  });

  it('адрес почты не считается упоминанием', () => {
    expect(isMentionOf('пиши на alice@bob.com', 'bob')).toBe(false);
    expect(isMentionOf('a@bob', 'bob')).toBe(false);
  });

  it('находит второе вхождение, если первое не подошло', () => {
    expect(isMentionOf('alice@bob.com и ещё @bob', 'bob')).toBe(true);
    expect(isMentionOf('@bobby, а также @bob', 'bob')).toBe(true);
  });

  it('имя с пробелом не ломает поиск', () => {
    expect(isMentionOf('привет @Иван Петров!', 'Иван Петров')).toBe(true);
    expect(isMentionOf('привет @Иван Петровский', 'Иван Петров')).toBe(false);
  });

  it('регулярные спецсимволы в имени не превращаются в шаблон', () => {
    // Если бы имя подставлялось в RegExp без экранирования, '.' совпала бы
    // с любым символом, а '+' и '(' уронили бы конструктор.
    expect(isMentionOf('@a.c', 'a.c')).toBe(true);
    expect(isMentionOf('@abc', 'a.c')).toBe(false);
    expect(isMentionOf('@c++', 'c++')).toBe(true);
    expect(isMentionOf('@(x)', '(x)')).toBe(true);
  });

  it('слишком короткое или пустое имя игнорируется', () => {
    expect(isMentionOf('@a привет', 'a')).toBe(false);
    expect(isMentionOf('@ привет', '')).toBe(false);
    expect(isMentionOf('@ привет', '   ')).toBe(false);
    expect(isMentionOf('@bob', null)).toBe(false);
    expect(isMentionOf('@bob', undefined)).toBe(false);
  });

  it('без собаки — не упоминание', () => {
    expect(isMentionOf('bob, привет', 'bob')).toBe(false);
  });

  it('пробелы вокруг имени в профиле не мешают', () => {
    expect(isMentionOf('@bob', '  bob  ')).toBe(true);
  });

  it('пустой текст', () => {
    expect(isMentionOf('', 'bob')).toBe(false);
  });
});
