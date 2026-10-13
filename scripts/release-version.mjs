// Вспомогательные функции для версий релизов GitHub.
// Исторические теги v0.0.<номер PR> остаются действительными; новые релизы
// начинают с версии из package.json и увеличивают номер исправления.

const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/;

export function parseReleaseVersion(value) {
  const match = String(value ?? '').trim().match(VERSION_RE);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

export function compareReleaseVersions(left, right) {
  const a = typeof left === 'string' ? parseReleaseVersion(left) : left;
  const b = typeof right === 'string' ? parseReleaseVersion(right) : right;
  if (!a || !b) throw new TypeError('Некорректный номер релиза.');
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function nextReleaseVersion(tags, baseVersion) {
  const base = parseReleaseVersion(baseVersion);
  if (!base) throw new TypeError('Базовая версия должна иметь формат X.Y или X.Y.Z.');

  let latest = base;
  let hasCurrentLineRelease = false;
  for (const tag of tags) {
    const version = parseReleaseVersion(tag);
    if (!version || compareReleaseVersions(version, base) < 0) continue;
    hasCurrentLineRelease = true;
    if (compareReleaseVersions(version, latest) > 0) latest = version;
  }

  // Первый релиз после перехода использует версию из package.json без изменений.
  // В следующих увеличивается номер исправления; теги всегда имеют формат X.Y.Z.
  const patch = latest.patch + (hasCurrentLineRelease ? 1 : 0);
  return `${latest.major}.${latest.minor}.${patch}`;
}

export function formatReleaseVersion(value) {
  const version = typeof value === 'string' ? parseReleaseVersion(value) : value;
  if (!version) return String(value ?? '').replace(/^v/, '');
  return version.patch === 0
    ? `${version.major}.${version.minor}`
    : `${version.major}.${version.minor}.${version.patch}`;
}

export function releaseTag(value) {
  const version = typeof value === 'string' ? parseReleaseVersion(value) : value;
  if (!version) throw new TypeError('Некорректный номер релиза.');
  return `v${version.major}.${version.minor}.${version.patch}`;
}
