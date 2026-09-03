/**
 * Маршрут доставки живёт в строке сообщения (v4.32.563).
 *
 * Путь известен ровно один раз — в момент отправки. Если его тогда не
 * записать (или записать так, что следующее сохранение статуса его сотрёт),
 * восстановить его потом неоткуда: транспорт не оставляет следов в CID.
 * Поэтому тесты держат всю цепочку: миграция → запись → чтение → экран.
 */
import fs from 'fs';
import path from 'path';

const read = (p: string): string => fs.readFileSync(path.join(__dirname, p), 'utf8');
const LOCAL = read('../local.ts');
const MSG = read('../../social/messaging.ts');
const MODAL = read('../../../ui/components/modals/chat/ChatMessageInfoModal.tsx');

describe('столбец маршрута', () => {
  it('добавляется миграцией, а не ожидается от новой базы', () => {
    expect(LOCAL).toContain("ALTER TABLE chat_messages ADD COLUMN transport TEXT");
    expect(LOCAL).toContain('await ensureMessageTransportColumn(database);');
  });

  it('миграция проверяет наличие столбца — повторный запуск не падает', () => {
    const fn = LOCAL.slice(LOCAL.indexOf('async function ensureMessageTransportColumn'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("PRAGMA table_info(chat_messages)");
    expect(body).toContain("c.name === 'transport'");
    expect(body).toContain('catch');
  });

  it('без столбца в INSERT OR REPLACE маршрут стирался бы при смене статуса', () => {
    const up = LOCAL.slice(LOCAL.indexOf('export async function upsertChatMessage'));
    const stmt = up.slice(0, up.indexOf('COMMIT'));
    expect(stmt).toContain('reply_to_preview, transport)');
    expect(stmt).toContain('row.transport ?? null');
    // Плейсхолдеров ровно столько же, сколько столбцов.
    const cols = (stmt.match(/INSERT OR REPLACE INTO chat_messages \(([^)]+)\)/) as RegExpMatchArray)[1];
    const vals = (stmt.match(/VALUES \(([^)]+)\)/) as RegExpMatchArray)[1];
    expect(vals.split(',').length).toBe(cols.split(',').length);
  });

  it('читается обратно в строку сообщения', () => {
    expect(LOCAL).toContain('transport: (r.transport as MessageRoute | null) ?? null,');
    expect(LOCAL).toContain('transport?: MessageRoute | null;');
  });

  it('входящему маршрут не выдумывается', () => {
    const t = LOCAL.slice(LOCAL.indexOf('export type MessageRoute'));
    expect(LOCAL.slice(0, LOCAL.indexOf('export type MessageRoute'))).toContain('чужой маршрут нам не виден');
    expect(t.slice(0, 200)).toContain("'ipfs' | 'lan' | 'internet' | 'wifi_direct'");
  });
});

describe('отправка записывает путь', () => {
  it('успешная публикация помечается как ipfs — и в «отправлено», и в «доставлено»', () => {
    const work = MSG.slice(MSG.indexOf('private async sendMessageWork'));
    expect(work).toContain("status: 'sent',\n      transport: 'ipfs',");
    expect(work).toContain("status: 'delivered',\n      transport: 'ipfs',");
  });

  it('запасной путь пишет тот транспорт, который подтвердил доставку', () => {
    const work = MSG.slice(MSG.indexOf('private async sendMessageWork'));
    expect(work).toContain('const fallbackVia = await multiTransportRouter.sendVia(payload, peerDid);');
    expect(work).toContain('transport: fallbackVia,');
  });

  it('веерная раздача через контакты по-прежнему запускается, когда никто не довёз', () => {
    const work = MSG.slice(MSG.indexOf('private async sendMessageWork'));
    expect(work).toContain('if (!fallbackVia) {');
    expect(work).toContain('void this.gossipDmToContacts(payload, peerDid, myDid);');
  });
});

describe('«Сведения о сообщении»', () => {
  it('называет маршрут по-человечески, а не именем транспорта', () => {
    expect(MODAL).toContain("lan: { title: 'По локальной сети'");
    expect(MODAL).toContain('Напрямую, без интернета');
    expect(MODAL).toContain("internet: { title: 'Через реле'");
  });

  it('у каждого значения MessageRoute есть подпись', () => {
    for (const k of ['ipfs', 'lan', 'internet', 'wifi_direct']) {
      expect(MODAL).toContain(`${k}: { title:`);
    }
  });

  it('без маршрута строка не рисуется вовсе — вместо догадки', () => {
    expect(MODAL).toContain('{msg.transport && ROUTE_LABELS[msg.transport] ? (');
    const row = MODAL.indexOf('{msg.transport &&');
    const cid = MODAL.indexOf('{msg.cid ? (');
    expect(row).toBeGreaterThan(0);
    expect(row).toBeLessThan(cid);
  });
});
