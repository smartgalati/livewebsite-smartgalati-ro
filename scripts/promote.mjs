// Promote a website candidate to production: download the two public release assets of the
// source repository, verify them, unpack, swap the test origin for the production origin,
// check the result. Nothing is rebuilt; the files are the ones reviewed on the test site.
//   CANDIDATE_TAG=website-candidate-<run>-<attempt> PRODUCTION_ORIGIN=https://<domain> \
//     node scripts/promote.mjs [output-dir]        (default output: _site)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SOURCE_REPOSITORY = 'smartgalati/devcapsule-www-smartgalati-ro';
export const TAG_PATTERN = /^website-candidate-[1-9][0-9]*-[1-9][0-9]*$/;
const TEXT = /\.(html?|txt|xml|json|js|mjs|css|svg|webmanifest|map)$/i;
const digest = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateCandidate(candidate, tag, repository = SOURCE_REPOSITORY) {
  assert.match(tag, TAG_PATTERN, 'Not a website candidate tag');
  assert.equal(candidate.schema, 1, 'Unknown candidate schema');
  assert.equal(candidate.tag, tag);
  assert.equal(tag, `website-candidate-${candidate.runId}-${candidate.runAttempt}`);
  assert.equal(candidate.repository, repository, 'Candidate comes from another repository');
  assert.match(candidate.sourceSha, /^[a-f0-9]{40}$/);
  assert.match(candidate.origin, /^https?:\/\/[a-z0-9.-]+$/);
  assert.match(candidate.digest, /^sha256:[a-f0-9]{64}$/);
  return candidate;
}

export function validateOrigin(origin) {
  assert.match(origin || '', /^https:\/\/[a-z0-9.-]+$/,
    'PRODUCTION_ORIGIN must be https://<domain> with no path or trailing slash. ' +
    'Set the custom domain and Enforce HTTPS in this repository\'s Pages settings.');
  return origin;
}

function files(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(path.join(dir, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}

/** Checksum first, then every path and entry type, and only then extract into a new directory. */
export function unpack(archive, directory, candidate) {
  assert.equal(digest(fs.readFileSync(archive)), candidate.digest, 'Candidate archive checksum mismatch');
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n');
  for (const name of names) {
    assert(/^[A-Za-z0-9_.@~+ /-]+$/.test(name) && !name.startsWith('/') && !name.split('/').includes('..'),
      `Unsupported archive path: ${name}`);
  }
  assert.equal(new Set(names.map((name) => path.posix.normalize(name))).size, names.length, 'Duplicate archive paths');
  const entries = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n');
  assert.equal(entries.length, names.length);
  assert(entries.every((line) => /^[d-]/.test(line)), 'Archive must contain only ordinary files and directories');
  fs.mkdirSync(directory); // Never merge with old or unchecked output.
  execFileSync('tar', ['-xzf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions']);
}

/** Swap the test origin (either scheme) for the production origin in text files; record provenance. */
export function promote(directory, candidate, productionOrigin) {
  validateOrigin(productionOrigin);
  const testHost = new URL(candidate.origin).host;
  assert.notEqual(testHost, new URL(productionOrigin).host, 'Production and test origins are the same');
  const pattern = new RegExp(`https?://${escape(testHost)}(?![A-Za-z0-9.-])`, 'g');
  let replaced = 0;
  for (const name of files(directory).filter((name) => TEXT.test(name))) {
    const file = path.join(directory, name);
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(pattern, () => (replaced++, productionOrigin));
    if (after !== before) fs.writeFileSync(file, after);
  }
  assert(replaced > 0, `The candidate never names its test origin ${candidate.origin}; refusing to guess`);
  const info = {
    productionOrigin,
    candidate: { tag: candidate.tag, digest: candidate.digest, testOrigin: candidate.origin },
    source: {
      repository: candidate.repository, revision: candidate.sourceSha,
      run: `https://github.com/${candidate.repository}/actions/runs/${candidate.runId}/attempts/${candidate.runAttempt}`,
    },
  };
  fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  return replaced;
}

/** The promoted site must be whole: no trace of the test host, right canonical, no dangling local link. */
export function check(directory, candidate, productionOrigin) {
  const testHost = new URL(candidate.origin).host;
  const all = files(directory);
  const exists = (target) => {
    const clean = decodeURIComponent(target.split(/[?#]/)[0]);
    const file = path.join(directory, clean);
    return fs.existsSync(file) && (fs.statSync(file).isFile() || fs.existsSync(path.join(file, 'index.html')));
  };
  const problems = [];
  let pages = 0;
  for (const name of all.filter((name) => TEXT.test(name))) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8');
    if (name !== 'build-info.json' && text.includes(testHost)) problems.push(`${name}: still names ${testHost}`);
    if (!/\.html?$/i.test(name)) continue;
    pages++;
    const canonical = text.match(/<link rel="canonical" href="([^"]*)"/);
    if (canonical && !canonical[1].startsWith(productionOrigin + '/')) problems.push(`${name}: canonical ${canonical[1]}`);
    for (const [, target] of text.matchAll(/\s(?:href|src)="(\/[^"/][^"]*|\/)"/g)) {
      if (!exists(target)) problems.push(`${name}: broken local link ${target}`);
    }
  }
  assert(pages > 0 && fs.existsSync(path.join(directory, 'index.html')), 'No pages in the candidate');
  assert.equal(problems.length, 0, `Promoted site failed its checks:\n- ${problems.slice(0, 20).join('\n- ')}`);
  return { files: all.length, pages };
}

export async function download(tag, directory, productionOrigin, { request = fetch, repository = SOURCE_REPOSITORY } = {}) {
  assert.match(tag || '', TAG_PATTERN, 'CANDIDATE_TAG must look like website-candidate-<run>-<attempt>');
  validateOrigin(productionOrigin);
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const get = async (name) => {
    // Public release assets: no Authorization header, no token to create or renew.
    const response = await request(base + name);
    assert(response.ok, `Candidate download failed (${response.status}): ${base + name}`);
    return response;
  };
  const candidate = validateCandidate(await (await get('candidate.json')).json(), tag, repository);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-download-'));
  try {
    const archive = path.join(temporary, 'website.tar.gz');
    fs.writeFileSync(archive, Buffer.from(await (await get('website.tar.gz')).arrayBuffer()));
    unpack(archive, directory, candidate);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  const replaced = promote(directory, candidate, productionOrigin);
  return { candidate, replaced, ...check(directory, candidate, productionOrigin) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const tag = process.env.CANDIDATE_TAG;
  const origin = (process.env.PRODUCTION_ORIGIN || '').replace(/\/+$/, '');
  const result = await download(tag, path.resolve(process.argv[2] || '_site'), origin);
  const { candidate } = result;
  console.log(`Promoted ${candidate.tag} (${candidate.digest}) to ${origin}: ` +
    `${result.files} files, ${result.pages} pages, ${result.replaced} origin references rewritten.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Promoting [${tag}](https://github.com/${candidate.repository}/releases/tag/${tag}) to ${origin}\n\n` +
      `Tested at: ${candidate.origin}\n\nSource: \`${candidate.repository}@${candidate.sourceSha}\`\n\n` +
      `Archive checksum: \`${candidate.digest}\`\n\n${result.files} files, ${result.pages} pages.\n`);
  }
}
