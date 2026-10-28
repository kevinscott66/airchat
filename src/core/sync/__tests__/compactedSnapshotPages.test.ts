import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { orphanAlbumItems, ALBUM_ORPHAN_GRACE_MS } from '../../social/storyAlbumOrphans';

// Exercise the production coordinator with paginated snapshots. Projection and
// network are controlled; orphan expiry uses the real deletion policy.
const source = fs.readFileSync(path.join(__dirname, '..', 'liveAccountSync.ts'), 'utf8');
const ast = ts.createSourceFile('liveAccountSync.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runLiveSync');
if (!declaration) throw new Error('missing production sync coordinator');
const compiled = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

test('expired orphan item survives until its compacted parent arrives on a later page', async () => {
  const albums = new Set<string>();
  const items = new Map<string, { id: string; albumId: string; addedAt: number }>();
  const sweep = jest.fn(async () => {
    const { lost } = orphanAlbumItems([...items.values()], [...albums], ALBUM_ORPHAN_GRACE_MS * 2,
      new Map([['item', 0]]));
    for (const item of lost) items.delete(item.id);
  });
  const pages = [
    [{ entityKind: 'story_album_item', entityId: 'item', revision: 1, deleted: false }],
    [{ entityKind: 'story_album', entityId: 'album', revision: 2, deleted: false }],
  ];
  const dependencies = {
    getConfigSync: () => ({ cloudBackup: { enabled: true } }), syncGeneration: 0,
    MAX_SYNC_PASSES: 20, MAX_PUSH_MUTATIONS: 100,
    collectPending: async () => ({ mutations: [], pendingHeads: new Map(), oversize: 0, held: 0 }),
    getSyncEntityHeads: async () => [],
    entityKey: (kind: string, id: string) => `${kind}:${id}`,
    decodedEntityId: (id: string) => id,
    applyPulledMutation: async (_mnemonic: string, mutation: { entityKind: string }) => {
      if (mutation.entityKind === 'story_album_item') items.set('item', { id: 'item', albumId: 'album', addedAt: 1 });
      else albums.add('album');
      return true;
    },
    syncAccountOnce: async (options: { applyMutation(m: unknown): Promise<void>; afterProjection(): Promise<void> }) => {
      const mutations = pages.shift() ?? [];
      for (const mutation of mutations) await options.applyMutation(mutation);
      await options.afterProjection();
      return { status: 'synced', pushed: null, poisoned: 0, pulled: { hasMore: pages.length > 0 } };
    },
    NO_SYNC_STUCK: { oversize: 0, held: 0, rejected: 0, poisoned: 0 },
    recordSyncStuck: jest.fn(),
    log: { warn: jest.fn() },
    require: () => ({ sweepOrphanAlbumItems: sweep }),
  };
  const run = new Function(...Object.keys(dependencies), `${compiled}; return runLiveSync;`)(...Object.values(dependencies));
  await run('seed', {}, 1, 0);
  expect(sweep).toHaveBeenCalledTimes(1);
  expect(albums.has('album')).toBe(true);
  expect(items.has('item')).toBe(true);
});

test('conflict recovery recollects and sends other mutations from the rejected batch', async () => {
  let pass = 0;
  const sent: string[][] = [];
  const dependencies = {
    getConfigSync: () => ({ cloudBackup: { enabled: true } }), syncGeneration: 0,
    MAX_SYNC_PASSES: 20, MAX_PUSH_MUTATIONS: 100,
    collectPending: async () => ({
      mutations: (pass === 0 ? ['committed', 'pending'] : ['pending']).map(mutationId => ({ mutationId })),
      pendingHeads: new Map(), oversize: 0, held: 0,
    }),
    getSyncEntityHeads: async () => [],
    entityKey: (kind: string, id: string) => `${kind}:${id}`,
    syncAccountOnce: async (options: { pendingMutations: { mutationId: string }[] }) => {
      sent.push(options.pendingMutations.map(m => m.mutationId));
      const conflict = pass++ === 0;
      return {
        status: 'synced', pushConflict: conflict, poisoned: 0,
        pushed: conflict ? null : { acceptedMutationIds: ['pending'], rejectedMutationIds: [] },
        pulled: { hasMore: false },
      };
    },
    NO_SYNC_STUCK: { oversize: 0, held: 0, rejected: 0, poisoned: 0 },
    recordSyncStuck: jest.fn(), log: { warn: jest.fn() },
  };
  const run = new Function(...Object.keys(dependencies), `${compiled}; return runLiveSync;`)(...Object.values(dependencies));
  await run('seed', {}, 1, 0);
  expect(sent).toEqual([['committed', 'pending'], ['pending']]);
});
