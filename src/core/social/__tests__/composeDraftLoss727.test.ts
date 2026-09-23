/**
 * v4.32.727: несохранившийся черновик публикации больше не молчит.
 *
 * Снимок черновика существует ради одного: следом запускается системный picker,
 * наша активити уходит в фон и Android вправе её убить (ровно поэтому снимок и
 * завели в v4.32.73, а в v4.32.321 распространили на камеру и документы).
 * Вернуться после перезапуска можно только к снимку.
 *
 * `kvSetSecret` отвечает `boolean` и отрицательный ответ здесь обычное дело:
 * полный диск, отказ базы, а на первом запуске — профиля, которому принадлежит
 * черновик, ещё нет (`compose_draft_no_owner`). Ответ выбрасывался, а
 * `saveComposeDraft` была объявлена `Promise<void>`: снаружи неудача записи
 * ничем не отличалась от удачи. Экран ленты во всех трёх местах открывал picker
 * следом, ничего человеку не сказав, — и убитая под picker'ом активити уносила
 * весь набранный пост: текст, фото, гео-метку, опрос.
 *
 * Поведение самого снимка проверяется вызовами; три места в экране — по
 * исходнику: FeedScreen в jest не поднимается.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Легла ли запись. Меняется прямо в тесте: это и есть предмет проверки. */
let mockKvSetSecretOk = true;

jest.mock('../../storage/local', () => {
  const kv: Record<string, string> = {};
  return {
    __kv: kv,
    kvGet: jest.fn(async () => null),
    kvSet: jest.fn(async () => undefined),
    kvDelete: jest.fn(async (k: string) => {
      delete kv[k];
    }),
    kvGetSecret: jest.fn(async (k: string) => kv[k] ?? null),
    kvSetSecret: jest.fn(async (k: string, v: string) => {
      // Отказ не бросает и ничего не пишет — как настоящий kvSetChecked.
      if (!mockKvSetSecretOk) return false;
      kv[k] = v;
      return true;
    }),
  };
});

let mockProfiles: Array<{ id: number; did: string }> = [];
jest.mock('../../identity/profileManager', () => ({
  profileManager: {
    getActiveProfile: () => mockProfiles[0] ?? null,
    getAllProfiles: () => mockProfiles,
  },
}));

jest.mock('../../logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { loadComposeDraft, saveComposeDraft, type ComposeDraft } from '../composeDraft';

const DID = 'did:key:zAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const SNAP: ComposeDraft = {
  draft: 'половина поста, которую человек уже набрал',
  uris: ['file:///photo/1.jpg'],
  pickedDocs: [],
  postLocationTag: '',
  isPollMode: false,
  pollQuestion: '',
  pollOptions: [],
  editingPostId: null,
};

beforeEach(() => {
  mockKvSetSecretOk = true;
  mockProfiles = [{ id: 1, did: DID }];
});

describe('снимок черновика отвечает, лёг ли он', () => {
  it('запись не легла — сказано «нет», а не «готово»', async () => {
    mockKvSetSecretOk = false;
    expect(await saveComposeDraft(DID, SNAP)).toBe(false);
    // И поднимать после перезапуска действительно нечего: ответ не врёт.
    expect(await loadComposeDraft(DID)).toBeNull();
  });

  it('ПРОВЕРКА НЕ ПУСТАЯ: удачная запись отвечает «да» и поднимается', async () => {
    expect(await saveComposeDraft(DID, SNAP)).toBe(true);
    expect((await loadComposeDraft(DID))?.draft).toBe(SNAP.draft);
  });

  it('профиля-владельца нет — тоже «нет»: черновику некуда лечь', async () => {
    mockProfiles = [];
    expect(await saveComposeDraft(DID, SNAP)).toBe(false);
  });
});

describe('экран ленты не открывает picker молча', () => {
  const CODE = fs
    .readFileSync(path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'), 'utf8')
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('помощник экрана отдаёт признак дальше, а не гасит его', () => {
    expect(CODE).toContain('const persistComposeDraft = useCallback(async (): Promise<boolean> => {');
    expect(CODE).toContain('return await saveComposeDraft(did, {');
  });

  it('все три способа приложить что-нибудь предупреждают', () => {
    const warn = "if (!(await persistComposeDraft())) showError(t('feed.draftNotKept'));";
    expect(CODE.split(warn).length - 1).toBe(3);
    // Молчаливого вызова не осталось ни одного.
    expect(CODE).not.toContain('await persistComposeDraft();');
  });

  it("предупреждение идёт ДО picker'а, пока текст ещё перед глазами", () => {
    for (const picker of [
      'DocumentPicker.getDocumentAsync({',
      'ImagePicker.launchCameraAsync({',
      'ImagePicker.launchImageLibraryAsync({',
    ]) {
      const at = CODE.indexOf(picker);
      expect(at).toBeGreaterThan(0);
      const before = CODE.lastIndexOf('persistComposeDraft())', at);
      expect(before).toBeGreaterThan(0);
      // Между предупреждением и picker'ом — ничего ждущего, кроме самого
      // picker'а: иначе предупреждение успело бы разойтись с моментом риска.
      const gap = CODE.slice(before, at);
      expect((gap.match(/await /g) ?? []).length).toBe(1);
    }
  });

  it('picker всё равно открывается: отменить выбор было бы хуже потери', () => {
    const warn = "if (!(await persistComposeDraft())) showError(t('feed.draftNotKept'));\n      return;";
    expect(CODE).not.toContain(warn);
  });

  it('текст предупреждения есть и говорит, что делать', () => {
    const ru = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', '..', 'i18n', 'ru.json'), 'utf8')
    ) as { feed: Record<string, string> };
    expect(ru.feed.draftNotKept).toBe('Черновик не сохранён. Скопируйте текст, если он важен');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('kvSetSecret по-прежнему отвечает неуспехом, не бросая', () => {
    const local = fs.readFileSync(
      path.join(__dirname, '..', '..', 'storage', 'local.ts'),
      'utf8'
    );
    expect(local).toContain('export async function kvSetSecret(key: string, value: string): Promise<boolean> {');
    expect(local).toContain('    return false;');
  });

  it('снимок по-прежнему нужен: восстановление после перезапуска живо', () => {
    const feed = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'ui', 'screens', 'FeedScreen.tsx'),
      'utf8'
    );
    expect(feed).toContain('const snap = await loadComposeDraft(did);');
  });
});
