/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('../errors.cjs');

// The panel updater has to reach the same version a CLI update would, so these
// rules mirror scripts/install.mjs. Only the decisions live here: every Git or
// filesystem effect arrives through the caller, which keeps the rules testable
// without a repository on disk.
//
// One deliberate difference from the CLI: when a tag does not look like
// vMAJOR.MINOR.PATCH, Git's own version sort would still order it. This module
// refuses instead, because silently selecting a different release than the CLI
// is worse than a clear error.

const METADATA_SCHEMA = 1;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/u;

const MODE_TAG = 'tag';
const MODE_COMMIT = 'commit';
const ACTION_UPDATE = 'update';
const ACTION_UNCHANGED = 'unchanged';
const ACTION_KEEP_AHEAD = 'keep-ahead';

function fail(code, message) {
    throw new PluginError(409, code, message);
}

function validateRef(ref, label) {
    if (typeof ref !== 'string' || ref.length === 0 || !REF_PATTERN.test(ref) || ref.includes('..')) {
        fail('UPDATER_INVALID_REF', `Invalid ${label} name.`);
    }
    return ref;
}

function parseTag(name) {
    const match = typeof name === 'string' ? TAG_PATTERN.exec(name) : null;
    if (!match) return null;
    return Object.freeze({
        core: Object.freeze([Number(match[1]), Number(match[2]), Number(match[3])]),
        prerelease: match[4] ?? null,
    });
}

// Mirrors `git -c versionsort.suffix=- tag --sort=version:refname`: the core
// versions compare numerically, and a release outranks its own prereleases.
function compareTags(left, right) {
    const a = parseTag(left);
    const b = parseTag(right);
    if (!a || !b) {
        fail(
            'UPDATER_UNKNOWN_TAG_SHAPE',
            `Cannot compare ${left} and ${right}: the updater only understands vMAJOR.MINOR.PATCH tags.`,
        );
    }
    for (let index = 0; index < a.core.length; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
    }
    if (a.prerelease === b.prerelease) return 0;
    if (a.prerelease === null) return 1;
    if (b.prerelease === null) return -1;
    return a.prerelease < b.prerelease ? -1 : 1;
}

// `branchHistory` is every commit reachable from the branch head, newest first.
// Git's `describe --tags --abbrev=0` walks the same way, so the first tagged
// commit encountered is the newest reachable release. Two tags on one commit
// are resolved by version instead of by enumeration order.
function selectReleaseTag({ tags, branchHistory }) {
    if (!Array.isArray(branchHistory) || branchHistory.length === 0) {
        fail('UPDATER_NO_HISTORY', 'The selected branch history is required to resolve the newest release tag.');
    }
    const byCommit = new Map();
    for (const entry of Array.isArray(tags) ? tags : []) {
        if (!entry || typeof entry.name !== 'string' || typeof entry.commit !== 'string') continue;
        if (!byCommit.has(entry.commit)) byCommit.set(entry.commit, []);
        byCommit.get(entry.commit).push(entry.name);
    }
    if (byCommit.size === 0) {
        fail('UPDATER_NO_TAG', 'No release tag is available for the selected branch.');
    }
    for (const commit of branchHistory) {
        const names = byCommit.get(commit);
        if (!names) continue;
        const name = names.slice().sort(compareTags).at(-1);
        return Object.freeze({ name, commit });
    }
    fail('UPDATER_NO_REACHABLE_TAG', 'No release tag is reachable from the selected branch.');
}

function readMetadata(metadata) {
    if (metadata === undefined || metadata === null) return null;
    if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata.schema !== METADATA_SCHEMA) {
        fail('UPDATER_INVALID_METADATA', 'The PayGo updater metadata is not schema version 1.');
    }
    if (metadata.mode !== MODE_TAG && metadata.mode !== MODE_COMMIT) {
        fail('UPDATER_INVALID_METADATA', 'The PayGo updater metadata records an unknown mode.');
    }
    return Object.freeze({
        schema: METADATA_SCHEMA,
        branch: validateRef(metadata.branch, 'tracking branch'),
        mode: metadata.mode,
        tag: metadata.tag === null || metadata.tag === undefined ? null : validateRef(metadata.tag, 'tag'),
        commit: typeof metadata.commit === 'string' ? metadata.commit : null,
    });
}

// An installation made by the host UI has no updater metadata yet, so the
// channel is inferred the same way the CLI infers it.
function inferChannel({ symbolicBranch = null, metadata = undefined, headTags = [], defaultBranch = 'main' }) {
    validateRef(defaultBranch, 'default branch');
    const stored = readMetadata(metadata);
    if (stored) {
        return Object.freeze({ branch: stored.branch, mode: stored.mode, tag: stored.tag, source: 'metadata' });
    }
    if (typeof symbolicBranch === 'string' && symbolicBranch.length > 0) {
        const branch = validateRef(symbolicBranch, 'branch');
        return Object.freeze({
            branch,
            mode: branch === defaultBranch ? MODE_TAG : MODE_COMMIT,
            tag: null,
            source: 'branch',
        });
    }
    // A detached HEAD on an exact tag is how older tag installs look. Git
    // decides that, never package.json: v0.3.1 still declared version 0.3.0.
    if (Array.isArray(headTags) && headTags.length > 0) {
        return Object.freeze({ branch: defaultBranch, mode: MODE_TAG, tag: headTags[0], source: 'tag' });
    }
    fail(
        'UPDATER_CHANNEL_UNKNOWN',
        'This installation does not record which release channel it follows. Run the installer once to record it, then retry.',
    );
}

function planUpdate({
    installedHead,
    installedBranch = null,
    dirtyTrackedCount = 0,
    channel,
    metadata = undefined,
    target,
    branchHead,
    isAncestor,
    forced = false,
    reference = null,
}) {
    if (typeof installedHead !== 'string' || installedHead.length === 0) {
        fail('UPDATER_NOT_INSTALLED', 'No installed Git revision was found for this component.');
    }
    if (typeof branchHead !== 'string' || branchHead.length === 0) {
        fail('UPDATER_NO_BRANCH_HEAD', 'The selected branch has no head revision.');
    }
    if (!target || typeof target.name !== 'string' || typeof target.commit !== 'string') {
        fail('UPDATER_NO_TARGET', 'The updater did not resolve a target release.');
    }
    if (typeof isAncestor !== 'function') {
        throw new TypeError('isAncestor is required.');
    }
    if (!channel || typeof channel.branch !== 'string' || typeof channel.mode !== 'string') {
        fail('UPDATER_CHANNEL_UNKNOWN', 'The release channel is unknown.');
    }

    if (dirtyTrackedCount > 0 && !forced) {
        fail(
            'UPDATER_LOCAL_CHANGES',
            `${dirtyTrackedCount} tracked files differ from the installed revision. Back them up and replace with the installer's --replace-modified option instead.`,
        );
    }
    if (!forced && !isAncestor(installedHead, branchHead)) {
        fail(
            'UPDATER_LOCAL_COMMITS',
            'The installed copy contains commits that are not on the selected branch. Use the installer with --replace-modified to back them up and replace them.',
        );
    }

    const stored = readMetadata(metadata);
    const sameChannel = Boolean(stored)
        && stored.branch === channel.branch
        && stored.mode === channel.mode
        && stored.tag === (channel.mode === MODE_TAG ? target.name : null);

    if (!forced && !isAncestor(installedHead, target.commit)) {
        // The installed revision is not behind the tag. On the same tag channel
        // a revision ahead of the newest tag is kept, because the project never
        // downgrades on its own.
        if (channel.mode === MODE_TAG && sameChannel && isAncestor(target.commit, installedHead)) {
            return Object.freeze({
                action: ACTION_KEEP_AHEAD,
                tag: target.name,
                commit: target.commit,
                reason: 'installed-revision-is-newer-than-the-newest-release-tag',
            });
        }
        fail(
            'UPDATER_OLDER_OR_DIVERGENT',
            `The selected release ${target.name} is older than or divergent from the installed revision. Use the installer with --replace-modified to replace it.`,
        );
    }

    const channelUnchanged = channel.mode === MODE_TAG || installedBranch === channel.branch;
    if (installedHead === target.commit && channelUnchanged && sameChannel && dirtyTrackedCount === 0) {
        return Object.freeze({
            action: ACTION_UNCHANGED,
            tag: target.name,
            commit: target.commit,
            reason: 'already-at-the-selected-release',
        });
    }

    return Object.freeze({
        action: ACTION_UPDATE,
        tag: channel.mode === MODE_TAG ? target.name : null,
        commit: target.commit,
        branch: channel.branch,
        mode: channel.mode,
        reference,
    });
}

module.exports = {
    ACTION_KEEP_AHEAD,
    ACTION_UNCHANGED,
    ACTION_UPDATE,
    METADATA_SCHEMA,
    MODE_COMMIT,
    MODE_TAG,
    compareTags,
    inferChannel,
    parseTag,
    planUpdate,
    readMetadata,
    selectReleaseTag,
    validateRef,
};
