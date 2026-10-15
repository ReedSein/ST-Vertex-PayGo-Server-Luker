# In-app component updates

The frontend panel can update both PayGo components without a terminal. The
rules it follows are the command-line installer's, so a panel update and a CLI
update reach the same release; what differs is the environment, because the
panel works inside a running host, without system Git and without npm.

## Why the panel needs its own implementation

`scripts/install.mjs` requires a stopped host and a system Git whose clone, tag
and ancestry commands do the version reasoning. Neither holds here: the host is
running, the plugin is itself one of the directories being replaced, and on
Android there is no system Git at all. The panel therefore keeps the installer's
*decisions* and replaces its *machinery*:

- Version selection, channel inference, local-change and local-commit
  protection, and the no-downgrade rule are reimplemented in
  `src/updater/version-policy.cjs` and exercised without a repository.
- Git work is done by isomorphic-git, bundled into
  `vendor/isomorphic-git.bundle.cjs` by `scripts/build-vendor.mjs`. The bundle
  is committed so that users still install nothing; `npm run vendor:check`
  fails when it no longer matches the pinned versions.
- The replacement transaction keeps the installer's shape: one lock, a staging
  directory on the same filesystem, a timestamped backup with a restore record,
  activation by rename, and rollback from that record.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/plugins/vertex-paygo/update` | Check both components and report what would change. |
| POST | `/api/plugins/vertex-paygo/update` | Start the update. Answers `202` and keeps working in the background. |
| GET | `/api/plugins/vertex-paygo/update/status` | The running job's phase and the last outcome. |

All three require an authenticated administrator, and the host's CSRF middleware
covers the write. The `/health` response advertises `capabilities.updater`,
where an absent field means this backend predates the feature, `false` means the
caller is not an administrator, and `true` means the panel may use it.

A check writes nothing to an installation. It resolves both directories, reads
their Git state, lists remote tags, clones both repositories into a staging
directory, and removes that directory again. The extension asks for a check only
when an administrator clicks, so nothing polls a remote on its own.

## Version rules

Identical to `scripts/install.mjs`:

- The channel comes from `.git/paygo-updater.json` when it exists, otherwise
  from the checked-out branch: `main` follows release tags, any other branch
  follows its own head. A detached HEAD sitting exactly on a release tag is read
  as the `main` tag channel, decided by Git and never by `package.json`.
- On the tag channel the target is the newest tag reachable from the branch
  head, which is what `git describe --tags --abbrev=0` selects. Two tags on one
  commit are separated by version, and a release outranks its own prereleases,
  matching `git -c versionsort.suffix=- tag --sort=-version:refname`.
- A release tag that does not look like `vMAJOR.MINOR.PATCH` is refused instead
  of ordered, because guessing could pick a different release than the CLI.
- Tracked local changes, commits absent from the remote history, and a selected
  release older than the installed revision all stop the update. An installed
  revision that is ahead of the newest tag is kept, never downgraded.
- Both components must move together. If either one is blocked the whole update
  stops, so a host cannot end up running mismatched halves.

## What an update does

1. Check both components and clone the target revisions into a staging
   directory, still without touching an installation.
2. Verify each prepared copy is the component it claims to be, still has its
   entry point, and contains no symlink.
3. Write the channel record into the prepared copy.
4. Take the lock, create the backup and its `restore.json`, then rename each
   target aside and the prepared copy into place.
5. Write `updater-report.json` into the backup and release the lock.

An error during preparation changes nothing. An error during activation rolls
back from the backup; if rollback itself fails, the reply names the backup
directory to recover from by hand. The manual recovery steps documented for the
installer apply here too, except that the panel never rewrites `config.yaml`.

## Boundaries

- **The plugin cannot repair itself.** A replacement that leaves the new plugin
  unable to load needs a host-side or manual recovery path. Automatic recovery
  from a failed start is not part of this feature.
- **Restarting is required.** Files on disk are updated while the host runs, so
  the running code is the previous version until the host restarts.
- **Non-Git installations are refused.** A copy installed from a ZIP has no
  revision to compare, so the panel reports it and points at the installer
  script instead of guessing.
- **The host has its own update channels.** Upstream SillyTavern and Luker both
  pull plugin repositories at startup when `enableServerPluginsAutoUpdate` is
  enabled (default `true`), and Luker additionally offers an extension update
  button. Those paths do not understand the paired-tag release and can move a
  component to `main` independently. The panel reports the situation but never
  edits the host configuration; pinning a release means disabling that setting.
- **Windows activation is untested.** Renaming a directory that contains loaded
  modules works on Linux and Android. On Windows an open handle can make the
  rename fail; the failure surfaces with the backup intact.
