import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bundledOpenFluxDocument } from '../openFluxDocument.web';

const { findDocumentUrls } = require('../../../scripts/check-web-config');

it('web ignores native build configuration', () => {
  const previous = process.env.EXPO_PUBLIC_OPENFLUX_DOC_URL;
  try {
    process.env.EXPO_PUBLIC_OPENFLUX_DOC_URL = 'https://docs.yandex.ru/test-only';
    expect(bundledOpenFluxDocument()).toBe('');
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_OPENFLUX_DOC_URL;
    else process.env.EXPO_PUBLIC_OPENFLUX_DOC_URL = previous;
  }
});

it('checks nested emitted chunks, including escaped URLs, without returning the address', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airchat-web-config-'));
  try {
    mkdirSync(join(dir, 'chunks'));
    writeFileSync(join(dir, 'index.html'), '<script src="chunks/native.js"></script>');
    writeFileSync(join(dir, 'chunks/native.js'), 'const doc="https:\\/\\/disk.yandex.ru/test-only";');
    expect(findDocumentUrls(dir)).toEqual(['chunks/native.js']);
    writeFileSync(join(dir, 'chunks/native.js'), 'const doc="";');
    expect(findDocumentUrls(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
