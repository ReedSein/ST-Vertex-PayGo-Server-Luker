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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createUpdater } = require('../src/updater/index.cjs');

const FRONTEND_REMOTE = 'https://github.com/mananekoha114/ST-Vertex-PayGo.git';
const SERVER_REMOTE = 'https://github.com/mananekoha114/ST-Vertex-PayGo-Server.git';
const FRONTEND_OLD = 'a'.repeat(40);
const SERVER_OLD = 'b'.repeat(40);
const FRONTEND_TIP = 'c'.repeat(40);
const SERVER_TIP = 'd'.repeat(40);

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

function writeText(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function makeHost() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-orchestration-'));
    writeJson(path.join(root, 'package.json'), { name: 'luker', version: '2.8.0' });
    const frontend = path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo');
    writeJson(path.join(frontend, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers', js: 'index.js', css: 'style.css' });
    writeText(path.join(frontend, 'index.js'), 'old frontend\n');
    writeText(path.join(frontend, 'style.css'), 'old styles\n');
    const server = path.join(root, 'plugins', 'ST-Vertex-PayGo-Server');
    writeJson(path.join(server, 'package.json'), { name: 'st-vertex-paygo-server', main: 'index.cjs' });
    writeText(path.join(server, 'index.cjs'), 'old server\n');
    return { root, frontend, server };
}

// A Git port with no network and no repository: the two things an update must
// learn from Git are supplied directly, and materialize writes the payload a
// real checkout would have produced.
function makeGitOperations({ frontendState, serverState }) {
    const states = new Map([[frontendState.directory, frontendState], [serverState.directory, serverState]]);
    return {
        async listRemoteTags(url) {
            return url === FRONTEND_REMOTE
                ? [{ name: 'v0.5.0', commit: FRONTEND_TIP }]
                : [{ name: 'v0.5.0', commit: SERVER_TIP }];
        },
        async readInstallation(directory) {
            return states.get(directory);
        },
        async stagedClone({ url, directory }) {
            fs.mkdirSync(directory, { recursive: true });
            return url === FRONTEND_REMOTE
                ? { branchHead: FRONTEND_TIP, history: [FRONTEND_TIP, FRONTEND_OLD] }
                : { branchHead: SERVER_TIP, history: [SERVER_TIP, SERVER_OLD] };
        },
        async materialize({ directory }) {
            if (path.basename(directory) === 'frontend') {
                writeJson(path.join(directory, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers', js: 'index.js', css: 'style.css' });
                writeText(path.join(directory, 'index.js'), 'new frontend\n');
                writeText(path.join(directory, 'style.css'), 'new styles\n');
            } else {
                writeJson(path.join(directory, 'package.json'), { name: 'st-vertex-paygo-server', main: 'index.cjs' });
                writeText(path.join(directory, 'index.cjs'), 'new server\n');
            }
        },
        writeMetadata(directory, record) {
            writeJson(path.join(directory, '.git', 'paygo-updater.json'), { schema: 1, ...record });
        },
        async isAncestor({ older, newer }) {
            if (older === newer) return true;
            return (older === FRONTEND_OLD && newer === FRONTEND_TIP) || (older === SERVER_OLD && newer === SERVER_TIP);
        },
    };
}

function installation(directory, { head, metadata, remote, dirtyTrackedCount = 0, isRepository = true, branch = 'main' }) {
    return { directory, isRepository, head, branch, dirtyTrackedCount, metadata, remoteUrl: remote };
}

function makeUpdater(host, overrides = {}) {
    return createUpdater({
        config: { values: {}, source: 'absent' },
        rootDir: host.root,
        now: () => new Date('2026-10-15T00:00:00.000Z'),
        gitOperations: makeGitOperations({
            frontendState: installation(host.frontend, { head: FRONTEND_OLD, metadata: null, remote: FRONTEND_REMOTE }),
            serverState: installation(host.server, { head: SERVER_OLD, metadata: null, remote: SERVER_REMOTE }),
            ...overrides,
        }),
    });
}

test('an update replaces both components, records the channel, and keeps a usable backup', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host);

        const report = await updater.check();
        assert.equal(report.status, 'update-available');
        assert.deepEqual(report.components.map(component => component.name), ['frontend', 'server']);
        assert.deepEqual(report.components.map(component => component.status), ['update', 'update']);
        assert.equal(report.components[0].target.tag, 'v0.5.0');
        // A check must not touch the installation.
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');

        const result = await updater.start();
        assert.equal(result.status, 'updated');
        assert.equal(result.restartRequired, true);
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'new frontend\n');
        assert.equal(fs.readFileSync(path.join(host.frontend, 'style.css'), 'utf8'), 'new styles\n');
        assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'new server\n');

        const metadata = JSON.parse(fs.readFileSync(path.join(host.frontend, '.git', 'paygo-updater.json'), 'utf8'));
        assert.deepEqual(metadata, { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: FRONTEND_TIP });

        const restore = JSON.parse(fs.readFileSync(path.join(result.backup, 'restore.json'), 'utf8'));
        assert.deepEqual(restore.components.map(component => component.name), ['frontend', 'server']);
        assert.equal(fs.readFileSync(path.join(result.backup, 'frontend', 'index.js'), 'utf8'), 'old frontend\n');
        assert.equal(fs.existsSync(path.join(result.backup, 'updater-report.json')), true);

        // No lock or staging directory survives a successful update.
        assert.deepEqual(fs.readdirSync(host.root).filter(name => name.startsWith('.paygo-install')).sort(), ['.paygo-install-backups']);
        assert.equal(updater.status().running, false);
        assert.equal(updater.status().lastResult.status, 'updated');
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('a blocked component stops the whole update instead of shipping half a release', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {
            frontendState: installation(host.frontend, { head: null, metadata: null, remote: null, isRepository: false }),
        });
        const report = await updater.check();
        assert.equal(report.status, 'blocked');
        assert.equal(report.components[0].status, 'not-a-repository');
        assert.match(report.components[0].reason, /not a Git checkout/u);

        // The job runs in the background, so a refusal is recorded as its
        // outcome rather than thrown at the caller that started it.
        const result = await updater.start();
        assert.equal(result.status, 'failed');
        assert.equal(result.code, 'UPDATER_COMPONENT_BLOCKED');
        assert.match(result.message, /not a Git checkout/u);
        assert.equal(fs.readFileSync(path.join(host.server, 'index.cjs'), 'utf8'), 'old server\n');
        assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('an installation already on the selected release is left alone', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {
            frontendState: installation(host.frontend, {
                head: FRONTEND_TIP,
                metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: FRONTEND_TIP },
                remote: FRONTEND_REMOTE,
            }),
            serverState: installation(host.server, {
                head: SERVER_TIP,
                metadata: { schema: 1, branch: 'main', mode: 'tag', tag: 'v0.5.0', commit: SERVER_TIP },
                remote: SERVER_REMOTE,
            }),
        });
        const report = await updater.check();
        assert.equal(report.status, 'up-to-date');
        assert.deepEqual(report.components.map(component => component.status), ['unchanged', 'unchanged']);

        const result = await updater.start();
        assert.equal(result.status, 'no-change');
        assert.equal(fs.readFileSync(path.join(host.frontend, 'index.js'), 'utf8'), 'old frontend\n');
        assert.equal(fs.existsSync(path.join(host.root, '.paygo-install-backups')), false);
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});

test('a copy installed from a different origin is reported but still updated from the official one', async () => {
    const host = makeHost();
    try {
        const updater = makeUpdater(host, {
            frontendState: installation(host.frontend, { head: FRONTEND_OLD, metadata: null, remote: 'https://example.invalid/fork.git' }),
        });
        const report = await updater.check();
        assert.equal(report.components[0].originMismatch, true);
        assert.equal(report.components[1].originMismatch, false);
        const result = await updater.start();
        assert.equal(result.status, 'updated');
    } finally {
        fs.rmSync(host.root, { recursive: true, force: true });
    }
});
