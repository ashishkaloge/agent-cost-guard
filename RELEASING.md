# npm releases

The manual [Prepare npm release](.github/workflows/publish.yml) workflow validates a
release and stages the verified tarball using npm trusted publishing. It never
approves a staged version. npm requires a maintainer's 2FA approval before that
version becomes public.

## Configure the publisher

In the npm settings for `@ashishkaloge/agent-cost-guard`, add a GitHub Actions trusted publisher:

- Owner: `ashishkaloge`
- Repository: `agent-cost-guard`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Keep direct `npm publish` and dist-tag management disabled; staging is allowed.

Keep the existing GitHub protection for `main`; the workflow rejects other
branches and refuses a commit if `main` has moved. Do not add an npm token
secret. The workflow uses short-lived OIDC credentials and npm generates
provenance for the public package.

A new npm trust configuration must complete its first successful publish within
two days. Configure it when the release is ready; if it expires, recreate the
configuration before the next release. After the first verified trusted publish,
select **Require two-factor authentication and disallow tokens** in npm's
publishing access settings.

## Release procedure

1. Update `package.json` and `package-lock.json` to the intended stable version
   in a reviewed pull request, then merge it after CI passes.
2. Open **Actions → Prepare npm release → Run workflow**, select `main`, enter the
   exact version as `expected_version`, and leave `dry_run` enabled. Review the
   checks and the generated tarball artifact. A dry run does not contact npm's
   staging service and can validate the already-published version.
3. Run the workflow on the reviewed `main` commit again with the same version
   and `dry_run` disabled. Staging refuses versions already in the public
   registry. npm also rejects a version that is already staged.
4. Review the stage in npm, including its source commit, package contents, and
   provenance. Approve it with 2FA only when it is ready to release.
5. Verify the public version and `latest` dist-tag, provenance, and a clean
   consumer installation. If the workflow fails after staging, inspect the
   existing stage before retrying; do not bump the version just to bypass it.

The build job runs the repository checks without OIDC permission. A separate
job verifies the artifact and stages the same tarball with lifecycle scripts
disabled. Only that job has `id-token: write`. Both jobs use GitHub-hosted
runners, fixed action commits, Node.js 24, npm 11.21.1, and no dependency cache.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
and [staged publishing](https://docs.npmjs.com/staged-publishing/).
