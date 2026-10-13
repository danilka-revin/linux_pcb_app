#!/usr/bin/env node
// Подставляет semver из релизного тега перед сборкой Windows-артефактов.
// Меняет только version в package.json и корне package-lock.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.argv[2] || '';
const version = raw.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Использование: node scripts/set-package-version.mjs 1.6.1');
  process.exit(2);
}

const packagePath = join(root, 'package.json');
const lockPath = join(root, 'package-lock.json');
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
pkg.version = version;
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log(`версия пакета для релиза: ${version}`);
