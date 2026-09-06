import { mergeChatWindow } from '../mergeChatWindow';

type Row = { id: string; createdAt: number; text: string; status?: string; editedAt?: number | null };

const row = (id: string, createdAt: number, text: string, extra: Partial<Row> = {}): Row => ({
  id, createdAt, text, ...extra,
});

// Окно всегда приходит из базы в порядке DESC — как и getMessages.
const win = (...rows: Row[]) => [...rows].sort((a, b) => b.createdAt - a.createdAt);

describe('mergeChatWindow', () => {
  it('правка текста доезжает до экрана', () => {
    const prev = win(row('a', 200, 'было'), row('b', 100, 'привет'));
    const latest = win(row('a', 200, 'стало', { editedAt: 500 }), row('b', 100, 'привет'));
    const next = mergeChatWindow(prev, latest);
    expect(next.map((m) => m.text)).toEqual(['стало', 'привет']);
    expect(next[0].editedAt).toBe(500);
  });

  it('удалённая строка уходит с экрана', () => {
    const prev = win(row('a', 300, 'раз'), row('b', 200, 'два'), row('c', 100, 'три'));
    const latest = win(row('a', 300, 'раз'), row('c', 100, 'три'));
    expect(mergeChatWindow(prev, latest).map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('строка старше границы окна не считается удалённой', () => {
    // Подгруженное листанием: окно про него ничего не знает.
    const prev = win(row('a', 300, 'новое'), row('old', 10, 'старое'));
    const latest = win(row('a', 300, 'новое'));
    expect(mergeChatWindow(prev, latest).map((m) => m.id)).toEqual(['a', 'old']);
  });

  it('совпадение времени с границей окна не стирает уцелевшую строку', () => {
    // Порядок в базе `created_at DESC, id DESC`: граница может пройти между
    // двумя строками одной миллисекунды.
    const prev = win(row('b2', 100, 'вторая'), row('b1', 100, 'первая'));
    const latest = [row('b2', 100, 'вторая')];
    expect(mergeChatWindow(prev, latest).map((m) => m.id)).toEqual(['b2', 'b1']);
  });

  it('новые сообщения добавляются с сохранением DESC', () => {
    const prev = win(row('a', 100, 'старое'));
    const latest = win(row('n', 300, 'новое'), row('a', 100, 'старое'));
    expect(mergeChatWindow(prev, latest).map((m) => m.id)).toEqual(['n', 'a']);
  });

  it('статус подтягивается, как и раньше', () => {
    const prev = win(row('a', 100, 'текст', { status: 'sending' }));
    const latest = win(row('a', 100, 'текст', { status: 'sent' }));
    expect(mergeChatWindow(prev, latest)[0].status).toBe('sent');
  });

  it('без изменений возвращается тот же массив', () => {
    const prev = win(row('a', 200, 'раз'), row('b', 100, 'два'));
    expect(mergeChatWindow(prev, prev.map((m) => ({ ...m })))).toBe(prev);
  });

  it('пустое окно очищает экран: удалено последнее сообщение', () => {
    const prev = win(row('a', 100, 'единственное'));
    expect(mergeChatWindow(prev, [], [])).toEqual([]);
  });

  it('границу задаёт всё окно, а не только видимая его часть', () => {
    // Надгробие (нулевой пробел) на экран не идёт, но место в выборке занимает:
    // без него граница уехала бы вверх и стёрла живое сообщение под ней.
    const tomb = row('t', 300, '​');
    const alive = row('a', 200, 'живое');
    const prev = win(alive);
    const next = mergeChatWindow(prev, [alive], win(tomb, alive));
    expect(next.map((m) => m.id)).toEqual(['a']);
  });
});
