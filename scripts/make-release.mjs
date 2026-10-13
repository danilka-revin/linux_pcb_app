#!/usr/bin/env node
// Релиз на каждый PR, смерженный в main. Исторические теги v0.0.<номер PR>
// сохраняются для совместимости; с версии 1.6.0 релизы получают semver-теги,
// а номер исправления увеличивается для каждого следующего PR.
//
// Запуск:
//   node scripts/make-release.mjs --backfill             # все смерженные PR (идемпотентно)
//   node scripts/make-release.mjs --pr 66                # один PR
//   node scripts/make-release.mjs --range A..B            # PR из диапазона коммитов (это использует CI)
//   node scripts/make-release.mjs --backfill --dry-run    # показать, что будет, ничего не создавая
//
// Опции:
//   --repo owner/name    репозиторий (по умолчанию GITHUB_REPOSITORY или origin)
//   --prefix v0.0.        формат исторических тегов для старых PR
//   --force              обновить заметки уже существующего релиза
//
// Нужно: git и gh (авторизованный, права write на contents). В CI вызывается из
// .github/workflows/release.yml. Заметки релиза собираются из тела PR — пишите
// заголовок и раздел «Что нового» по-русски, тогда и описание релиза будет русским.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareReleaseVersions,
  formatReleaseVersion,
  nextReleaseVersion,
  parseReleaseVersion,
  releaseTag,
} from './release-version.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const DRY = flag('dry-run') === true || argv.includes('--dry-run');
const FORCE = flag('force') === true || argv.includes('--force');
const PREFIX = typeof flag('prefix') === 'string' ? flag('prefix') : 'v0.0.';
const PACKAGE = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
const BASE_VERSION = String(PACKAGE.version || '');
if (!parseReleaseVersion(BASE_VERSION)) throw new Error('В package.json указана некорректная версия релиза.');

const sh = (cmd, args) => {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim() };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || e.stderr || e.message).trim() };
  }
};
const git = (args) => sh('git', args);
const NL = String.fromCharCode(10);

const REPO =
  (typeof flag('repo') === 'string' && flag('repo')) ||
  process.env.GITHUB_REPOSITORY ||
  (git(['remote', 'get-url', 'origin']).out || '')
    .replace(/^.*github\.com[:/]/, '')
    .replace(/\.git$/, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO || '')) {
  console.error('не удалось определить репозиторий — передайте --repo owner/name');
  process.exit(2);
}

const gh = (args) => sh('gh', args.concat(['--repo', REPO]));
const PR_JSON = 'number,title,body,baseRefName,mergedAt,mergeCommit,headRefName,additions,deletions,changedFiles,url';

// ---------- заметки ----------
// Служебные секции PR (про прогоны тестов/валидацию) в релизе только мешают.
const NOISE_HEADING = /^(validation|checks?|test plan|quality gates?|проверки|проверка)$/i;

function cleanBody(body) {
  const out = [];
  let skip = 0;
  let fence = false;
  for (const line of String(body || '').split(NL)) {
    if (/^ {0,3}```/.test(line)) fence = !fence;
    const h = fence ? null : line.match(/^(#{1,6})\s+(.*)$/);
    if (skip) {
      if (h && h[1].length <= skip) skip = 0;
      else continue;
    }
    if (h && h[1].length <= 3 && NOISE_HEADING.test(h[2].replace(/[:\s]+$/, ''))) {
      skip = h[1].length;
      continue;
    }
    if (/^\s*Co-Authored-By:/i.test(line)) continue;
    if (/^\s*<\/?(details|summary)/i.test(line)) continue;
    // заголовки из тела PR опускаем на два уровня — они не должны спорить с заголовком релиза
    if (h) out.push('#'.repeat(Math.min(6, h[1].length + 2)) + ' ' + h[2]);
    else out.push(line);
  }
  return out
    .join(NL)
    .replace(new RegExp(NL + '{3,}', 'g'), NL + NL)
    .trim();
}

const LIMIT = 1400;
function summarize(body) {
  const text = cleanBody(body);
  if (!text) return '_Подробное описание — в PR ниже._';
  if (text.length <= LIMIT) return text;
  const cut = text.slice(0, LIMIT);
  const nl = Math.max(cut.lastIndexOf(NL + NL), cut.lastIndexOf(NL + '- '), cut.lastIndexOf('. '));
  const head = nl > LIMIT * 0.4 ? cut.slice(0, nl + 1).trim() : cut.trim() + '…';
  return head + NL + NL + '_(полное описание — по ссылке на PR ниже)_';
}

function notesFor(pr, prevTag, tag) {
  const version = formatReleaseVersion(tag);
  const url = pr.url || 'https://github.com/' + REPO + '/pull/' + pr.number;
  const sha = (pr.mergeCommit && pr.mergeCommit.oid) || '';
  return [
    '## Версия ' + version,
    '',
    '### ' + String(pr.title || 'Изменения').trim(),
    '',
    summarize(pr.body),
    '',
    '---',
    '',
    '- **Дата выхода:** ' + String(pr.mergedAt || '').slice(0, 10),
    '- **Запрос на включение изменений:** [#' + pr.number + '](' + url + ')' + (pr.headRefName ? ' (ветка `' + pr.headRefName + '`)' : ''),
    sha ? '- **Коммит:** [' + sha.slice(0, 7) + '](https://github.com/' + REPO + '/commit/' + sha + ')' : null,
    '- **Изменено файлов:** ' + (pr.changedFiles || 0) + ', добавлено +' + (pr.additions || 0) + ' / удалено −' + (pr.deletions || 0),
    prevTag
      ? '- **Сравнение с предыдущим релизом:** [' + prevTag + '…' + tag + '](https://github.com/' + REPO + '/compare/' + prevTag + '...' + tag + ')'
      : null,
  ]
    .filter((x) => x !== null)
    .join(NL) + NL;
}

// ---------- отбор PR ----------
function prsFromList() {
  const r = gh(['pr', 'list', '--state', 'merged', '--base', 'main', '--limit', '300', '--json', PR_JSON]);
  if (r.code !== 0) throw new Error('gh pr list: ' + r.out.slice(0, 300));
  return JSON.parse(r.out || '[]');
}

function prView(n) {
  const r = gh(['pr', 'view', String(n), '--json', PR_JSON]);
  if (r.code !== 0) return null;
  let p;
  try {
    p = JSON.parse(r.out);
  } catch {
    return null;
  }
  return p && p.mergedAt && p.baseRefName === 'main' ? p : null;
}

// PR, чьи мерж-коммиты попали в диапазон коммитов пуша. Их может быть несколько
// (merge queue или батч push'ей) — на каждый положен свой релиз.
function prsFromRange(range) {
  const parts = String(range).split('..');
  const from = parts[0];
  const to = parts[1] || 'HEAD';
  const spec = !from || /^0+$/.test(from) ? to : from + '..' + to;
  let r = git(['log', '--format=%H%x09%s', spec]);
  if (r.code !== 0) r = git(['log', '-1', '--format=%H%x09%s', 'HEAD']); // нет предка (мелкий клон) — берём HEAD
  if (r.code !== 0) return [];
  const nums = [];
  for (const line of r.out.split(NL).filter(Boolean)) {
    const subj = line.slice(line.indexOf('\t') + 1);
    const n =
      (subj.match(/Merge pull request #(\d+)/) || [])[1] ||
      (subj.match(/\(#(\d+)\)\s*$/) || [])[1]; // squash-мердж
    if (n) nums.push(Number(n));
  }
  return nums.filter((x, i) => nums.indexOf(x) === i).sort((a, b) => a - b);
}

// ---------- создание ----------
// Смотрим на remote, а не на локальные refs: в CI и в мелком клоне локальных тегов не будет.
const tagExists = (tag) => git(['ls-remote', '--exit-code', 'origin', 'refs/tags/' + tag]).code === 0;
const releaseExists = (tag) => gh(['release', 'view', tag]).code === 0;

function releaseList() {
  const r = gh(['release', 'list', '--limit', '300']);
  if (r.code !== 0) throw new Error('gh release list: ' + r.out.slice(0, 300));
  return r.out.split(NL).filter(Boolean).map((line) => {
    const columns = line.split('\t');
    return { name: (columns[0] || '').trim(), tag: (columns[2] || '').trim(), body: null };
  }).filter((release) => release.tag);
}

function remoteTagMap() {
  const r = git(['ls-remote', '--tags', '--refs', 'origin']);
  if (r.code !== 0) throw new Error('git ls-remote --tags: ' + r.out.slice(0, 300));
  const tags = new Map();
  for (const line of r.out.split(NL).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]+)\s+refs\/tags\/(.+)$/);
    if (match) tags.set(match[2], match[1]);
  }
  return tags;
}

function isLegacyTag(tag) {
  return tag.startsWith(PREFIX) && /^\d+$/.test(tag.slice(PREFIX.length));
}

function legacyPrMax(tags) {
  return tags.reduce((max, tag) => {
    if (!isLegacyTag(tag)) return max;
    return Math.max(max, Number(tag.slice(PREFIX.length)));
  }, 0);
}

function previousReleaseTag(tag, occupiedTags) {
  const version = parseReleaseVersion(tag);
  if (!version) return null;
  const previous = [...occupiedTags]
    .filter((candidate) => {
      const parsed = parseReleaseVersion(candidate);
      return parsed && compareReleaseVersions(parsed, version) < 0;
    })
    .sort(compareReleaseVersions);
  return previous.at(-1) || null;
}

function containsPr(body, number) {
  return String(body || '').includes(`https://github.com/${REPO}/pull/${number}`);
}

function releaseForPr(pr, releases, tags) {
  const sha = pr.mergeCommit && pr.mergeCommit.oid;
  for (const [tag, target] of tags) {
    if (!isLegacyTag(tag) && parseReleaseVersion(tag) && target === sha) return tag;
  }
  for (const release of releases) {
    if (isLegacyTag(release.tag) || !parseReleaseVersion(release.tag)) continue;
    if (release.body == null) {
      const view = gh(['release', 'view', release.tag, '--json', 'body']);
      if (view.code === 0) {
        try { release.body = JSON.parse(view.out).body || ''; } catch { release.body = ''; }
      } else {
        release.body = '';
      }
    }
    if (containsPr(release.body, pr.number)) return release.tag;
  }
  return null;
}

function releaseTitle(pr, tag) {
  const version = formatReleaseVersion(tag);
  const subject = String(pr.title || 'Обновления программы').replace(/\s+/g, ' ').trim();
  return ('Версия ' + version + ' — ' + subject).slice(0, 200);
}

function createRelease(pr, tag, prevTag) {
  const sha = pr.mergeCommit && pr.mergeCommit.oid;
  if (!sha) {
    console.log('пропуск #' + pr.number + ': нет merge-коммита');
    return 'skip';
  }
  const exists = releaseExists(tag);
  if (exists && !FORCE) {
    console.log('уже есть: ' + tag);
    return 'skip';
  }
  const title = releaseTitle(pr, tag);
  const notes = notesFor(pr, prevTag, tag);
  if (DRY) {
    console.log('[dry-run] ' + tag + ' @ ' + sha.slice(0, 7) + ' — ' + title);
    return 'dry';
  }

  const dir = mkdtempSync(join(tmpdir(), 'psbees-release-'));
  const file = join(dir, 'notes.md');
  writeFileSync(file, notes);
  try {
    // Тег пушим git'ом, а не через API релиза: push refs/tags/v* — стандартный крючок
    // для CI-сборок (см. scripts/win/windows.yml), которые добавят exe к этому релизу.
    let haveTag = tagExists(tag);
    if (!haveTag) {
      const push = git(['push', 'origin', '+' + sha + ':refs/tags/' + tag]);
      haveTag = push.code === 0 || tagExists(tag);
      if (!haveTag) console.log('  тег не пушнулся — создадим его релизом: ' + push.out.slice(0, 160));
    }
    const created = exists
      ? gh(['release', 'edit', tag, '--title', title, '--notes-file', file])
      : gh(
          ['release', 'create', tag, '--title', title, '--notes-file', file, '--latest'].concat(
            haveTag ? ['--verify-tag'] : ['--target', sha]
          )
        );
    if (created.code !== 0) {
      console.error('ошибка ' + tag + ': ' + created.out.slice(0, 300));
      return 'fail';
    }
    console.log('готово: ' + tag + ' — ' + title);
    return 'ok';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const range = flag('range');
  const one = flag('pr');
  let list;
  if (one && one !== true) {
    const p = prView(Number(one));
    if (!p) throw new Error('PR #' + one + ' не смержен в main — релиз не нужен');
    list = [p];
  } else if (range && range !== true) {
    list = prsFromRange(range).map(prView).filter(Boolean);
  } else {
    list = prsFromList();
  }
  list = list
    .filter((p) => p && p.mergeCommit && p.mergeCommit.oid)
    .sort((a, b) => a.number - b.number);
  if (!list.length) {
    console.log('нет новых смерженных в main PR — релиз создавать не нужно');
    return;
  }

  const releases = releaseList();
  const tags = remoteTagMap();
  const occupiedTags = new Set([...releases.map((release) => release.tag), ...tags.keys()]);
  const firstSemverPr = legacyPrMax([...occupiedTags]) + 1;
  let done = 0;
  let failed = 0;

  for (const pr of list) {
    const legacyTag = PREFIX + pr.number;
    let tag;
    if (pr.number < firstSemverPr || isLegacyTag(legacyTag) && occupiedTags.has(legacyTag)) {
      // Старые релизы сохраняют прежние теги, чтобы не ломать ссылки на сравнение и ассеты.
      tag = legacyTag;
    } else {
      tag = releaseForPr(pr, releases, tags);
      if (!tag) tag = releaseTag(nextReleaseVersion([...occupiedTags], BASE_VERSION));
    }

    const prevTag = previousReleaseTag(tag, occupiedTags);
    const result = createRelease(pr, tag, prevTag);
    if (result === 'ok') done++;
    if (result === 'fail') failed++;

    // В dry-run тоже резервируем номер, чтобы батч показывал непрерывную нумерацию.
    occupiedTags.add(tag);
    if (result === 'ok' || result === 'dry') {
      const notes = notesFor(pr, prevTag, tag);
      releases.unshift({ tag, name: releaseTitle(pr, tag), body: notes });
    }
  }
  console.log('создано релизов: ' + done + ' из ' + list.length + ' (' + REPO + ')' + (failed ? ', ошибок: ' + failed : ''));
  if (failed) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}
