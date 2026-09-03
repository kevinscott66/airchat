/**
 * Рэтчет v4.32.571: «Запрет копирования и пересылки» перестал быть половиной
 * обещания.
 *
 * Что было. Переключатель в карточке профиля закрывал «Копировать»,
 * «Переслать», выгрузку и снимок экрана — но только у того, кто его нажал. В
 * карточке об этом было написано честно («Настройка местная»), и от этого она
 * не переставала быть настройкой, которую включают РАДИ собеседника, а
 * работает она везде, кроме его телефона.
 *
 * Что закреплено здесь:
 *  1. решение уходит собеседнику служебным конвертом и через общую воронку;
 *  2. чужое решение живёт в отдельном ключе и не снимается своей рукой;
 *  3. фоновый приём пишет в профиль-владелец конверта, а не в активный;
 *  4. обе стороны видят системную строку — иначе у получателя кнопки пропадают
 *     молча и это выглядит поломкой приложения;
 *  5. карточка называет, чьё это решение, и больше не обещает «местную»
 *     настройку.
 *
 * Проверяем исходники: экран и базу в тесте не поднять, а пропажу условия
 * видно сразу и она стоит одну строку.
 */
import * as fs from 'fs';
import * as path from 'path';

const dir = (...p: string[]): string => path.join(__dirname, '..', ...p);
const guard = fs.readFileSync(dir('copyGuard.ts'), 'utf8');
const sync = fs.readFileSync(dir('copyGuardSync.ts'), 'utf8');
const messaging = fs.readFileSync(dir('messaging.ts'), 'utf8');
const peek = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'components', 'UserProfilePeek.tsx'),
  'utf8'
);
const hub = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'ui', 'components', 'profileHubModel.ts'),
  'utf8'
);

/** Строки без комментариев — чтобы запреты не срабатывали на пояснениях. */
function codeLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('решение уходит собеседнику', () => {
  it('рассылка идёт через общую воронку служебных конвертов', () => {
    const code = codeLines(sync);
    expect(code).toContain("fanoutControlEnvelope('copy_guard'");
    // Своей копии отправки быть не должно — правило «что считать отправленным»
    // живёт в controlFanout.
    expect(code).not.toContain('getMessagingService');
    expect(code).not.toContain('svc.sendMessage(');
  });

  it('отказ доставки называется словами, а не молчит', () => {
    expect(sync).toContain(
      'export type CopyGuardSyncResult = { synced: true } | { synced: false; warning: string };'
    );
    expect(sync).toContain('return { synced: false, warning: copyGuardWarning(on, delivery.reason) };');
    expect(sync).toContain('return { synced: true };');
    // Включение и снятие описаны по-разному: «у него ещё работает» и «у него
    // ещё выключено» — разные беды.
    expect(sync).toContain("const head = on ? 'Запрет включён только у вас' : 'Запрет снят только у вас';");
    expect(sync).toContain("const why = fanoutReasonText(reason, 'dm');");
  });

  it('у себя записано до отправки — отказ рассылки этого не отменяет', () => {
    const local = sync.indexOf('await setCopyGuard(peerPubB64, on);');
    const send = sync.indexOf('fanoutControlEnvelope(');
    expect(local).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(local);
    expect(sync.indexOf('if (!delivery.sent)')).toBeGreaterThan(send);
  });

  it('входящий конверт разбирается в переписке и пузырём не становится', () => {
    expect(messaging).toContain("import { COPY_GUARD_PREFIX } from './copyGuardEnvelope';");
    const idx = messaging.indexOf('if (textPayload.text?.startsWith(COPY_GUARD_PREFIX)) {');
    expect(idx).toBeGreaterThan(0);
    const branch = messaging.slice(idx, idx + 320);
    expect(branch).toContain("await import('./copyGuardSync')");
    expect(branch).toContain('handleIncomingCopyGuard(textPayload.text, peerPubKeyB64, ownerPid)');
    expect(branch).toContain('return;');
  });
});

describe('чужое решение отделено от своего', () => {
  it('ключа два, и они разные', () => {
    expect(guard).toContain("const PREFIX = 'copy_guard:';");
    expect(guard).toContain("const PEER_PREFIX = 'copy_guard_peer:';");
  });

  it('переписка закрыта, пока горит хотя бы один ключ', () => {
    expect(guard).toContain('return state.mine || state.theirs;');
    expect(guard).toContain('return copyGuardOn(await copyGuardState(peerPubB64));');
  });

  it('своя запись не трогает чужую и наоборот', () => {
    const setMine = guard.slice(
      guard.indexOf('export async function setCopyGuard('),
      guard.indexOf('export async function setPeerCopyGuardFor(')
    );
    expect(setMine).toContain('copyGuardKey(peerPubB64)');
    expect(setMine).not.toContain('peerCopyGuardKey(');
  });

  it('приём конверта пишет в профиль-владелец, а не в активный', () => {
    // Активным к моменту разбора может быть уже другой аккаунт (v4.32.481).
    const body = guard.slice(guard.indexOf('export async function setPeerCopyGuardFor('));
    expect(body).toContain('scopedKvSetFor(pid, peerCopyGuardKey(peerPubB64)');
    expect(body).toContain('scopedKvDeleteFor(pid, peerCopyGuardKey(peerPubB64))');
    expect(sync).toContain('await setPeerCopyGuardFor(ownerPid, senderPubB64, env.on);');
  });

  it('экран не перекрашивается решением из чужого профиля', () => {
    const notify = guard.slice(guard.indexOf('function notify('), guard.indexOf('export async function copyGuardStateFor'));
    expect(notify).toContain('if (pid !== activeProfileId()) return;');
  });
});

describe('обе стороны видят, что произошло', () => {
  it('системная строка пишется и на приёме, и на отправке', () => {
    expect(sync).toContain('byMe: true');
    expect(sync).toContain('byMe: false');
    // Общий префикс системных строк, а не своя копия литерала (v4.32.263).
    expect(sync).toContain("import { SYS_LINE_PREFIX } from './sysLineGuard';");
    expect(codeLines(sync)).not.toContain("'\\x0bsys:'");
  });

  it('id строки детерминированный — повтор конверта не плодит дубликатов', () => {
    expect(sync).toContain("id: `cg-${byMe ? 'me' : 'peer'}-${key}-${on ? '1' : '0'}`");
  });

  it('место в ленте — по своему времени, а не по чужому', () => {
    expect(sync).toContain('createdAt: Date.now(),');
    expect(codeLines(sync)).not.toContain('createdAt: env.ts');
  });
});

describe('карточка профиля говорит правду', () => {
  it('обещание «настройка местная» снято', () => {
    expect(peek).not.toContain('Настройка местная');
    expect(peek).toContain('будет нельзя ни вам, ни собеседнику');
    // Граница названа: держится запрет приложением собеседника.
    expect(peek).toContain('У собеседника запрет держится его приложением');
  });

  it('переключатель отправляет решение, а не пишет его молча себе', () => {
    expect(peek).toContain("import { setCopyGuardAndSync } from '../../core/social/copyGuardSync';");
    expect(peek).toContain('void setCopyGuardAndSync({ peerPubB64: pub, on: next })');
    expect(peek).toContain('if (!res.synced) { showError(res.warning); return; }');
  });

  it('чужой запрет не снимается своей рукой и объясняется словами', () => {
    expect(peek).toContain('if (!copyGuard && copyGuardByPeer) {');
    expect(peek).toContain("'Запрет включил собеседник',");
  });

  it('строка настройки называет, чьё это решение', () => {
    expect(hub).toContain("value: f.copyGuard ? 'Вкл' : f.copyGuardByPeer ? 'Вкл собеседником' : 'Выкл',");
    expect(hub).toContain('copyGuardByPeer: boolean;');
  });
});

describe('служебный конверт не протекает на экран', () => {
  it('байт \\x16 записан в фильтры превью и поиска', () => {
    const preview = fs.readFileSync(dir('messagePreview.ts'), 'utf8');
    const search = fs.readFileSync(dir('searchableText.ts'), 'utf8');
    expect(preview).toContain("'\\x15', '\\x16'];");
    expect(search).toContain("'\\x15', '\\x16'];");
  });
});
