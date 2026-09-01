#!/usr/bin/env node
/**
 * expo-image-picker 16.1.0 calls EXFatal(EXErrorWithMessage(...)) when
 * NSCameraUsageDescription is missing, but those symbols were removed from
 * ExpoModulesCore in SDK 55 → the iOS build fails with
 * "cannot find 'EXFatal' in scope". We always ship the usage descriptions
 * (app.json infoPlist), so that fatal branch is never taken at runtime; here we
 * replace the uncompilable call with a plain NSLog so the file builds.
 *
 * Idempotent; run from `postinstall` so a fresh `npm install` re-applies it.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname,
  '..',
  'node_modules',
  'expo-image-picker',
  'ios',
  'ImagePickerPermissionRequesters.swift',
);

try {
  if (!fs.existsSync(file)) process.exit(0);
  let src = fs.readFileSync(file, 'utf8');
  if (!src.includes('EXFatal(')) process.exit(0); // already patched

  // Replace the multi-line `EXFatal(EXErrorWithMessage(""" ... """))` call with
  // an NSLog of the same message (compiles on SDK 55, harmless — the enclosing
  // branch only runs if the Info.plist key is absent, which it never is).
  src = src.replace(
    /EXFatal\(EXErrorWithMessage\((""")([\s\S]*?)(""")\)\)/g,
    'NSLog($1$2$3)',
  );

  fs.writeFileSync(file, src, 'utf8');
  console.log('[ensure-expo-image-picker-swift] patched EXFatal → NSLog');
} catch (e) {
  console.warn('[ensure-expo-image-picker-swift] skip:', e.message);
}
