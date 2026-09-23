/**
 * Точка входа проверки. Здесь нет ни одной строки самой проверки — только то,
 * что обязано случиться ДО первого импорта ядра.
 *
 * Причина в порядке выполнения ESM: статические импорты модуля вычисляются
 * раньше любого его кода, а ядро на загрузке уже трогает базу — например,
 * `rateLimiter` поднимает при создании список заблокированных. Назначь
 * рабочий каталог первой строкой `startCore`, и эти обращения всё равно
 * случились бы раньше неё, на пустом `workdir`. Поэтому каталог назначается
 * здесь, а ядро подтягивается динамическим импортом уже после — то же правило
 * действует для любого запуска, не только для проверки.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { setWorkdir } from './runtime/workdir';

const mode = process.argv[2];

if (mode === '--boot-only') {
  // Дочерний режим: второй каталог для проверки детерминизма DID.
  const dir = process.argv[3];
  if (!dir) throw new Error('boot_only_needs_workdir');
  setWorkdir(dir);
  const { runBootOnly } = await import('./proofBody');
  await runBootOnly(dir);
  process.exit(0);
} else {
  const root =
    process.argv[2] ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'airchat-node-host-')));
  setWorkdir(path.join(root, 'a'));
  const { runProof } = await import('./proofBody');
  await runProof(root);
  process.exit(process.exitCode ?? 0);
}
