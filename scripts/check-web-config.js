#!/usr/bin/env node
// Check the emitted files, not just source: Expo inlines EXPO_PUBLIC variables.
const fs = require('fs');
const path = require('path');

function findDocumentUrls(root) {
  const found = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:js|json|html|map)$/i.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8').replace(/\\\//g, '/');
        if (/https?:\/\/(?:docs|disk)\.yandex\.ru\//i.test(text)) {
          found.push(path.relative(root, full));
        }
      }
    }
  }
  walk(root);
  return found;
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || 'dist');
  const files = findDocumentUrls(root);
  if (files.length) {
    // Never print the URL itself, including in public CI logs.
    console.error('Native document URL found in web output:\n' + files.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Web config: no native document URLs in emitted files');
  }
}

module.exports = { findDocumentUrls };
