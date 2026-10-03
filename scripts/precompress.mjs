#!/usr/bin/env node
// Предсжатие собранных файлов (dist/*.js, *.css, *.html, *.json, *.svg).
//
// Зачем именно на сборке, а не «на лету»: сервер PSBees часто работает на том
// же слабом устройстве, что и редактор, и сжатие каждого запроса отнимало бы у
// него CPU. Здесь мы один раз платим временем сборки и кладём рядом с файлом
// его .br и .gz; сервер (scripts/server.mjs) просто отдаёт готовое, если
// браузер поддерживает brotli/gzip. Экономия на канале существенная:
// основной бандл ~670 КБ минифицированного JS отдаётся ~150 КБ.
//
// Файлы меньше порога не сжимаем — оверхед заголовков больше выигрыша.
import { brotliCompress, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const dist = process.argv[2] ? join(root, process.argv[2]) : join(root, 'dist');

const MIN_BYTES = 1024;                    // ~1 КБ: ниже сжатие не окупается
const TYPES = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.map', '.txt', '.xml', '.wasm']);
const SKIP = /\.(gz|br)$/;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

async function main() {
  let files;
  try {
    files = await walk(dist);
  } catch {
    console.error(`precompress: нет каталога ${dist} — сначала выполните сборку.`);
    process.exitCode = 1;
    return;
  }
  let saved = 0, total = 0, count = 0;
  for (const file of files) {
    if (SKIP.test(file) || !TYPES.has(extname(file).toLowerCase())) continue;
    const info = await stat(file);
    if (info.size < MIN_BYTES) continue;
    const data = await readFile(file);
    const br = await brotli(data, {
      params: {
        // Качество 11 даёт максимум, но собирается заметно дольше; для JS/CSS
        // разница в размере с 10 небольшая — берём 10 для скорости сборки.
        [/* BROTLI_PARAM_QUALITY */ 1]: 10,
      },
    });
    const gz = await gzipAsync(data, { level: 9 });
    total += data.length;
    // Пишем только то, что реально меньше исходника, и не оставляем старые
    // версии (файлы в assets/ и так уникальны по хэшу).
    if (br.length < data.length) {
      await writeFile(file + '.br', br);
      saved += data.length - br.length;
      count++;
    } else {
      await unlink(file + '.br').catch(() => {});
    }
    if (gz.length < data.length) await writeFile(file + '.gz', gz);
    else await unlink(file + '.gz').catch(() => {});
  }
  const pct = total ? Math.round((saved / total) * 100) : 0;
  console.log(`precompress: ${count} файлов с brotli, исходно ${(total / 1024).toFixed(1)} КБ, ` +
    `экономия от brotli ${(saved / 1024).toFixed(1)} КБ (${pct}%)`);
}

await main();
