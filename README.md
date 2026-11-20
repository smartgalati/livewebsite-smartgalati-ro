# ACS Smart Galați — production website

This repository publishes the club's **production** website. It holds no site
source: it takes a site that was already built, checked and reviewed on the
test site, and publishes those same files.

## How a change reaches production

1. **Change and test.** A change is pushed to `main` of
   [`smartgalati/devcapsule-www-smartgalati-ro`](https://github.com/smartgalati/devcapsule-www-smartgalati-ro).
   Its workflow runs the checks, publishes the **test site**, and saves the
   exact published files as a release named
   `website-candidate-<run>-<attempt>` (the *candidate tag*).
2. **Review.** Look at the test site. Copy the candidate tag from the
   workflow run's summary or from that repository's
   [releases](https://github.com/smartgalati/devcapsule-www-smartgalati-ro/releases).
3. **Publish.** Here: **Actions → Publish production website → Run
   workflow**, branch `main`, paste the candidate tag. Wait for `prepare` and
   `deploy`.
4. **Confirm.** Open the production site, and `/build-info.json` on it: it
   names the candidate tag, the source revision and the test run that is live.

**Rolling back** is the same step 3 with an older candidate tag. Candidates
are kept as releases in the test repository; do not delete the ones you may
want to return to.

## What the publish step does

[`scripts/promote.mjs`](scripts/promote.mjs), run by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml):

- downloads `candidate.json` and `website.tar.gz` from the candidate release
  (public download, no token);
- checks the tag, the source repository and the archive's SHA-256, and
  refuses archives with links, special files or unsafe paths;
- replaces the test site's address with the production address, which is
  whatever custom domain this repository's Pages settings name, in the HTML
  and other text files: canonical links and sharing addresses;
- writes `build-info.json`;
- checks that no page still names the test site and that no local link is
  broken, then hands the result to GitHub Pages.

Nothing is rebuilt: content, styles, scripts and images are the reviewed bytes.

## One-time setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Custom domain:** enter the production domain and create its DNS record
   (`CNAME` to `smartgalati.github.io` for a `www` name). After GitHub issues
   the certificate, tick **Enforce HTTPS**. The workflow refuses to publish
   without a custom domain served over HTTPS.
3. **Settings → Environments → github-pages:** deployment is limited to
   `main` by default. Add *Required reviewers* here if a second person must
   approve each production publish.
4. The test repository must be public (or its releases otherwise publicly
   downloadable), because the candidate is fetched without credentials.

No secret or personal token is needed.

## Working on this repository

`npm test` runs the unit tests of the promotion script (Node.js 22, no
dependencies). To try a promotion locally:

```sh
CANDIDATE_TAG=website-candidate-<run>-<attempt> \
  PRODUCTION_ORIGIN=https://<production-domain> node scripts/promote.mjs _site
```
