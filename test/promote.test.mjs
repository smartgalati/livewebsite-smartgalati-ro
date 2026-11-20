import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { download, promote, check, unpack, validateCandidate, validateOrigin, SOURCE_REPOSITORY } from '../scripts/promote.mjs';

const PROD = 'https://www.example.org';
const TEST = 'http://webtest.example.org';
const tag = 'website-candidate-77-2';

function fixture(t, { origin = TEST, extra = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'contact'), { recursive: true });
  fs.mkdirSync(path.join(site, '_astro'));
  const page = (url, body) => `<html><head><link rel="canonical" href="${origin}${url}"><meta property="og:url" content="${origin}${url}"></head><body>${body}</body></html>`;
  fs.writeFileSync(path.join(site, 'index.html'), page('/', '<a href="/contact/">c</a><img src="/_astro/a.png"><a href="https://lichess.org/">l</a>'));
  fs.writeFileSync(path.join(site, 'contact', 'index.html'), page('/contact/', '<a href="/">home</a><a href="/#top">top</a>'));
  fs.writeFileSync(path.join(site, '_astro', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  fs.writeFileSync(path.join(site, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  extra(site);
  const archive = path.join(root, 'website.tar.gz');
  execFileSync('tar', ['-czf', archive, '--format=ustar', '-C', site, '.']);
  const candidate = {
    schema: 1, tag, repository: SOURCE_REPOSITORY, runId: '77', runAttempt: '2', sourceSha: 'c'.repeat(40), origin,
    digest: 'sha256:' + createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
  };
  const request = async (url) => {
    const name = url.split('/').pop();
    assert(url.startsWith(`https://github.com/${SOURCE_REPOSITORY}/releases/download/${tag}/`));
    return name === 'candidate.json'
      ? { ok: true, json: async () => candidate }
      : { ok: true, arrayBuffer: async () => fs.readFileSync(archive) };
  };
  return { root, site, archive, candidate, request, out: path.join(root, 'out') };
}

test('download verifies, unpacks, rewrites only the origin and records provenance', async (t) => {
  const f = fixture(t);
  const result = await download(tag, f.out, PROD, { request: f.request });
  assert.equal(result.replaced, 4);
  assert.equal(result.pages, 2);
  const home = fs.readFileSync(path.join(f.out, 'index.html'), 'utf8');
  assert.match(home, /<link rel="canonical" href="https:\/\/www\.example\.org\/">/);
  assert.match(home, /https:\/\/lichess\.org\//);
  assert.equal(home, fs.readFileSync(path.join(f.site, 'index.html'), 'utf8').replaceAll(TEST, PROD));
  assert.deepEqual(fs.readFileSync(path.join(f.out, '_astro', 'a.png')), fs.readFileSync(path.join(f.site, '_astro', 'a.png')));
  const info = JSON.parse(fs.readFileSync(path.join(f.out, 'build-info.json'), 'utf8'));
  assert.equal(info.candidate.tag, tag);
  assert.equal(info.productionOrigin, PROD);
  assert.equal(info.source.revision, 'c'.repeat(40));
});

test('both schemes of the test host are rewritten, a longer host name is not', (t) => {
  const f = fixture(t, { extra: (site) => fs.writeFileSync(path.join(site, 'note.txt'),
    'https://webtest.example.org/a http://webtest.example.org.evil/b') });
  promote(f.site, f.candidate, PROD);
  assert.equal(fs.readFileSync(path.join(f.site, 'note.txt'), 'utf8'), 'https://www.example.org/a http://webtest.example.org.evil/b');
});

test('a changed archive is refused before anything is extracted', async (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.archive, 'x');
  await assert.rejects(download(tag, f.out, PROD, { request: f.request }), /checksum mismatch/);
  assert.equal(fs.existsSync(f.out), false);
});

test('archives with links or escaping paths are refused', (t) => {
  const f = fixture(t, { extra: (site) => fs.symlinkSync('/etc/passwd', path.join(site, 'link')) });
  assert.throws(() => unpack(f.archive, f.out, f.candidate), /ordinary files/);
  assert.equal(fs.existsSync(f.out), false);
});

test('an existing output directory is never merged into', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.out);
  assert.throws(() => unpack(f.archive, f.out, f.candidate), /EEXIST/);
});

test('a broken local link or a leftover test host fails the check', (t) => {
  const f = fixture(t, { extra: (site) => fs.writeFileSync(path.join(site, '404.html'), '<a href="/missing/">x</a>') });
  promote(f.site, f.candidate, PROD);
  assert.throws(() => check(f.site, f.candidate, PROD), /broken local link \/missing\//);
  const g = fixture(t);
  assert.throws(() => check(g.site, g.candidate, PROD), /still names webtest\.example\.org/);
});

test('metadata, tag, repository and production origin are validated', async (t) => {
  const f = fixture(t);
  assert.throws(() => validateCandidate({ ...f.candidate, repository: 'someone/else' }, tag), /another repository/);
  assert.throws(() => validateCandidate({ ...f.candidate, runAttempt: '3' }, tag));
  assert.throws(() => validateOrigin('http://www.example.org'), /https/);
  assert.throws(() => validateOrigin('https://org.github.io/repo'), /https/);
  assert.throws(() => validateOrigin(''), /https/);
  await assert.rejects(download('v1.2.3', f.out, PROD, { request: f.request }), /website-candidate/);
  assert.throws(() => promote(f.site, f.candidate, 'https://webtest.example.org'), /same/);
});

test('a failed download names the address', async (t) => {
  const f = fixture(t);
  await assert.rejects(download(tag, f.out, PROD, { request: async () => ({ ok: false, status: 404 }) }), /404.*candidate\.json/);
});
