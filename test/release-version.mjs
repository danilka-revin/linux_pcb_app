import assert from 'node:assert/strict';
import {
  compareReleaseVersions,
  formatReleaseVersion,
  nextReleaseVersion,
  parseReleaseVersion,
  releaseTag,
} from '../scripts/release-version.mjs';

assert.deepEqual(parseReleaseVersion('v0.0.65'), { major: 0, minor: 0, patch: 65 });
assert.deepEqual(parseReleaseVersion('1.6'), { major: 1, minor: 6, patch: 0 });
assert.equal(parseReleaseVersion('v1.6.0-rc.1'), null);
assert.equal(compareReleaseVersions('v1.10.0', 'v1.9.99'), 1);
assert.equal(formatReleaseVersion('v1.6.0'), '1.6');
assert.equal(formatReleaseVersion('v1.6.1'), '1.6.1');
assert.equal(releaseTag('1.6'), 'v1.6.0');

// История v0.0.x остается прежней; следующая версия берётся из package.json.
assert.equal(nextReleaseVersion(['v0.0.64', 'v0.0.65'], '1.6.0'), '1.6.0');
assert.equal(nextReleaseVersion(['v0.0.65', 'v1.6.0'], '1.6.0'), '1.6.1');
assert.equal(nextReleaseVersion(['v1.6.1', 'v1.6.3'], '1.6.0'), '1.6.4');
assert.equal(nextReleaseVersion(['v1.6.3', 'v2.0.0'], '1.6.0'), '2.0.1');

console.log('release-version: переход на 1.6.0 и последовательная нумерация релизов OK');
