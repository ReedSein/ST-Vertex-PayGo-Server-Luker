/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ACTION_KEEP_AHEAD,
    ACTION_UNCHANGED,
    ACTION_UPDATE,
    compareTags,
    inferChannel,
    planUpdate,
    selectReleaseTag,
} = require('../src/updater/version-policy.cjs');

// A parent map is enough to answer ancestry the way a repository would.
function ancestry(graph) {
    return (older, newer) => {
        const seen = new Set();
        let cursor = newer;
        while (typeof cursor === 'string' && !seen.has(cursor)) {
            if (cursor === older) return true;
            seen.add(cursor);
            cursor = graph.get(cursor);
        }
        return false;
    };
}

function rejectsCode(fn, code) {
    assert.throws(fn, error => error?.code === code);
}

test('release tags compare numerically and a release outranks its prereleases', () => {
    assert.ok(compareTags('v0.5.0', 'v0.4.0') > 0);
    assert.ok(compareTags('v0.4.0', 'v0.5.0') < 0);
    assert.equal(compareTags('v0.5.0', 'v0.5.0'), 0);
    assert.ok(compareTags('v0.5.0', 'v0.5.0-rc1') > 0);
    assert.ok(compareTags('v0.5.0-rc2', 'v0.5.0-rc1') > 0);
    assert.ok(compareTags('v0.10.0', 'v0.9.9') > 0);
    rejectsCode(() => compareTags('0.5.0', 'v0.5.0'), 'UPDATER_UNKNOWN_TAG_SHAPE');
    rejectsCode(() => compareTags('v0.5.0', 'release-2'), 'UPDATER_UNKNOWN_TAG_SHAPE');
});

test('the newest reachable tag wins even when an older commit carries a higher tag', () => {
    const tags = [
        { name: 'v0.9.0', commit: 'c1' },
        { name: 'v0.4.0', commit: 'c3' },
    ];
    assert.deepEqual(selectReleaseTag({ tags, branchHistory: ['c4', 'c3', 'c2', 'c1'] }), {
        name: 'v0.4.0',
        commit: 'c3',
    });
});

test('two tags on one commit are resolved by version, not by enumeration order', () => {
    const history = ['c3', 'c2'];
    assert.equal(selectReleaseTag({
        tags: [{ name: 'v0.4.0', commit: 'c3' }, { name: 'v0.4.1', commit: 'c3' }],
        branchHistory: history,
    }).name, 'v0.4.1');
    assert.equal(selectReleaseTag({
        tags: [{ name: 'v0.5.0-rc1', commit: 'c3' }, { name: 'v0.5.0', commit: 'c3' }],
        branchHistory: history,
    }).name, 'v0.5.0');
});

test('tag selection fails loudly instead of guessing', () => {
    rejectsCode(() => selectReleaseTag({ tags: [], branchHistory: ['c1'] }), 'UPDATER_NO_TAG');
    rejectsCode(() => selectReleaseTag({ tags: [{ name: 'v1.0.0', commit: 'c1' }], branchHistory: [] }), 'UPDATER_NO_HISTORY');
    rejectsCode(() => selectReleaseTag({
        tags: [{ name: 'v1.0.0', commit: 'elsewhere' }],
        branchHistory: ['c1', 'c2'],
    }), 'UPDATER_NO_REACHABLE_TAG');
});

test('the release channel comes from recorded metadata first, then from the branch', () => {
    assert.deepEqual(
        inferChannel({
            symbolicBranch: 'feat/other',
            metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: 'c9' },
        }),
        { branch: 'main', mode: 'tag', tag: 'v0.5.0', source: 'metadata' },
    );
    assert.equal(inferChannel({ symbolicBranch: 'main' }).mode, 'tag');
    assert.equal(inferChannel({ symbolicBranch: 'feat/in-app-updates' }).mode, 'commit');
    assert.deepEqual(
        inferChannel({ headTags: ['v0.5.0'] }),
        { branch: 'main', mode: 'tag', tag: 'v0.5.0', source: 'tag' },
    );
});

test('unusable channel records fail closed', () => {
    rejectsCode(() => inferChannel({ metadata: { schema: 2, branch: 'main', mode: 'tag' } }), 'UPDATER_INVALID_METADATA');
    rejectsCode(() => inferChannel({ metadata: { schema: 1, branch: 'main', mode: 'rolling' } }), 'UPDATER_INVALID_METADATA');
    rejectsCode(() => inferChannel({ metadata: { schema: 1, branch: '../escape', mode: 'tag' } }), 'UPDATER_INVALID_REF');
    rejectsCode(() => inferChannel({}), 'UPDATER_CHANNEL_UNKNOWN');
});

test('a clean installation behind the newest tag updates to it', () => {
    const plan = planUpdate({
        installedHead: 'c1',
        installedBranch: 'main',
        channel: { branch: 'main', mode: 'tag', tag: null },
        metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.4.0', commit: 'c1' },
        target: { name: 'v0.5.0', commit: 'c3' },
        branchHead: 'c3',
        isAncestor: ancestry(new Map([['c3', 'c2'], ['c2', 'c1']])),
    });
    assert.equal(plan.action, ACTION_UPDATE);
    assert.equal(plan.tag, 'v0.5.0');
    assert.equal(plan.commit, 'c3');
});

test('local changes and local commits block the update unless it is forced', () => {
    const isAncestor = ancestry(new Map([['c3', 'c2'], ['c2', 'c1']]));
    const base = {
        installedHead: 'c1',
        installedBranch: 'main',
        channel: { branch: 'main', mode: 'tag', tag: null },
        target: { name: 'v0.5.0', commit: 'c3' },
        branchHead: 'c3',
        isAncestor,
    };
    rejectsCode(() => planUpdate({ ...base, dirtyTrackedCount: 2 }), 'UPDATER_LOCAL_CHANGES');
    rejectsCode(() => planUpdate({ ...base, installedHead: 'local' }), 'UPDATER_LOCAL_COMMITS');
    assert.equal(planUpdate({ ...base, dirtyTrackedCount: 2, forced: true }).action, ACTION_UPDATE);
    assert.equal(planUpdate({ ...base, installedHead: 'local', forced: true }).action, ACTION_UPDATE);
});

test('an installation ahead of the newest tag is kept, not downgraded', () => {
    const isAncestor = ancestry(new Map([['c3', 'c2'], ['c2', 'c1']]));
    const plan = planUpdate({
        installedHead: 'c3',
        installedBranch: 'main',
        channel: { branch: 'main', mode: 'tag', tag: null },
        metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: 'c3' },
        target: { name: 'v0.5.0', commit: 'c1' },
        branchHead: 'c3',
        isAncestor,
    });
    assert.equal(plan.action, ACTION_KEEP_AHEAD);
    assert.equal(plan.reason, 'installed-revision-is-newer-than-the-newest-release-tag');

    rejectsCode(() => planUpdate({
        installedHead: 'c3',
        installedBranch: 'main',
        channel: { branch: 'main', mode: 'tag', tag: null },
        metadata: { schema: 1, branch: 'other', mode: 'tag', tag: 'v0.5.0', commit: 'c3' },
        target: { name: 'v0.5.0', commit: 'c1' },
        branchHead: 'c3',
        isAncestor,
    }), 'UPDATER_OLDER_OR_DIVERGENT');
});

test('an identical, clean, same-channel installation reports no change', () => {
    const plan = planUpdate({
        installedHead: 'c3',
        installedBranch: 'main',
        channel: { branch: 'main', mode: 'tag', tag: null },
        metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: 'c3' },
        target: { name: 'v0.5.0', commit: 'c3' },
        branchHead: 'c3',
        isAncestor: ancestry(new Map([['c3', 'c2']])),
    });
    assert.equal(plan.action, ACTION_UNCHANGED);
});

test('an installation without channel metadata rewrites it even at the same revision', () => {
    const plan = planUpdate({
        installedHead: 'c3',
        installedBranch: 'main',
        channel: { branch: 'main', mode: 'tag', tag: null },
        target: { name: 'v0.5.0', commit: 'c3' },
        branchHead: 'c3',
        isAncestor: ancestry(new Map([['c3', 'c2']])),
    });
    assert.equal(plan.action, ACTION_UPDATE);
});

test('a development branch follows its own head in commit mode', () => {
    const plan = planUpdate({
        installedHead: 'd1',
        installedBranch: 'feat/in-app-updates',
        channel: { branch: 'feat/in-app-updates', mode: 'commit', tag: null },
        metadata: { schema: 1, branch: 'feat/in-app-updates', mode: 'commit', tag: null, commit: 'd1' },
        target: { name: 'v0.5.0', commit: 'd2' },
        branchHead: 'd2',
        isAncestor: ancestry(new Map([['d2', 'd1']])),
    });
    assert.equal(plan.action, ACTION_UPDATE);
    assert.equal(plan.mode, 'commit');
    assert.equal(plan.tag, null);
    assert.equal(plan.branch, 'feat/in-app-updates');
});

test('an installation without a Git revision cannot be updated', () => {
    rejectsCode(() => planUpdate({
        installedHead: '',
        channel: { branch: 'main', mode: 'tag', tag: null },
        target: { name: 'v0.5.0', commit: 'c3' },
        branchHead: 'c3',
        isAncestor: () => true,
    }), 'UPDATER_NOT_INSTALLED');
});
