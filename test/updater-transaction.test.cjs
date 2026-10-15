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

const {
    acquireLock,
    activate,
    createBackup,
    createStaging,
    releaseLock,
    removePath,
    rollback,
} = require('../src/updater/transaction.cjs');

function makeRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-tx-'));
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

function read(file) {
    return fs.readFileSync(file, 'utf8');
}

test('the lock admits one updater and frees the host afterwards', () => {
    const root = makeRoot();
    try {
        const lock = acquireLock(root);
        assert.equal(fs.existsSync(lock), true);
        assert.throws(() => acquireLock(root), error => error?.code === 'UPDATER_BUSY');
        releaseLock(lock);
        const again = acquireLock(root);
        releaseLock(again);
        assert.equal(fs.existsSync(lock), false);
    } finally {
        removePath(root);
    }
});

test('activation replaces both components and keeps the previous contents in the backup', () => {
    const root = makeRoot();
    try {
        const staging = createStaging(root);
        assert.equal(fs.statSync(staging).mode & 0o777, 0o700);
        const stagedFrontend = path.join(staging, 'frontend');
        const stagedServer = path.join(staging, 'server');
        write(path.join(stagedFrontend, 'index.js'), 'new frontend');
        write(path.join(stagedServer, 'index.cjs'), 'new server');

        const frontendTarget = path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo');
        const serverTarget = path.join(root, 'plugins', 'ST-Vertex-PayGo-Server');
        write(path.join(frontendTarget, 'index.js'), 'old frontend');
        write(path.join(serverTarget, 'index.cjs'), 'old server');

        const entries = [
            { name: 'frontend', target: frontendTarget, staged: stagedFrontend },
            { name: 'server', target: serverTarget, staged: stagedServer },
        ];
        const backup = createBackup(root, entries);
        assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
        const restore = JSON.parse(read(path.join(backup, 'restore.json')));
        assert.equal(restore.components.length, 2);
        assert.deepEqual(restore.components.map(entry => entry.name), ['frontend', 'server']);
        assert.equal(restore.components.every(entry => entry.existed === true), true);

        activate({ rootDir: root, backup, entries });
        assert.equal(read(path.join(frontendTarget, 'index.js')), 'new frontend');
        assert.equal(read(path.join(serverTarget, 'index.cjs')), 'new server');
        assert.equal(read(path.join(backup, 'frontend', 'index.js')), 'old frontend');
        assert.equal(read(path.join(backup, 'server', 'index.cjs')), 'old server');
        assert.equal(fs.existsSync(stagedFrontend), false);
    } finally {
        removePath(root);
    }
});

test('a failed activation puts the previous contents back', () => {
    const root = makeRoot();
    try {
        const staging = createStaging(root);
        const stagedFrontend = path.join(staging, 'frontend');
        write(path.join(stagedFrontend, 'index.js'), 'new frontend');

        const frontendTarget = path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo');
        write(path.join(frontendTarget, 'index.js'), 'old frontend');

        const entries = [
            { name: 'frontend', target: frontendTarget, staged: stagedFrontend },
            // This staged path does not exist, so activation stops after the
            // first component has already been replaced.
            { name: 'server', target: path.join(root, 'plugins', 'ST-Vertex-PayGo-Server'), staged: path.join(staging, 'missing') },
        ];
        write(path.join(root, 'plugins', 'ST-Vertex-PayGo-Server', 'index.cjs'), 'old server');
        const backup = createBackup(root, entries);

        assert.throws(() => activate({ rootDir: root, backup, entries }), error => error?.code === 'UPDATER_ACTIVATION_FAILED');
        assert.equal(read(path.join(frontendTarget, 'index.js')), 'old frontend');
        assert.equal(read(path.join(root, 'plugins', 'ST-Vertex-PayGo-Server', 'index.cjs')), 'old server');
    } finally {
        removePath(root);
    }
});

test('rollback also undoes a first installation that had no previous directory', () => {
    const root = makeRoot();
    try {
        const staging = createStaging(root);
        const staged = path.join(staging, 'frontend');
        write(path.join(staged, 'index.js'), 'first install');
        const target = path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo');
        const entries = [{ name: 'frontend', target, staged }];
        const backup = createBackup(root, entries);
        assert.equal(JSON.parse(read(path.join(backup, 'restore.json'))).components[0].existed, false);

        const activated = activate({ rootDir: root, backup, entries });
        assert.equal(read(path.join(target, 'index.js')), 'first install');
        assert.deepEqual(rollback(activated), []);
        assert.equal(fs.existsSync(target), false);
    } finally {
        removePath(root);
    }
});

test('targets outside the host root are refused before anything moves', () => {
    const root = makeRoot();
    const outside = makeRoot();
    try {
        const staging = createStaging(root);
        const staged = path.join(staging, 'frontend');
        write(path.join(staged, 'index.js'), 'payload');
        const entries = [{ name: 'frontend', target: path.join(outside, 'ST-Vertex-PayGo'), staged }];
        const backup = createBackup(root, entries);
        assert.throws(() => activate({ rootDir: root, backup, entries }), error => error?.code === 'UPDATER_ACTIVATION_FAILED');
        assert.equal(fs.existsSync(path.join(outside, 'ST-Vertex-PayGo')), false);
    } finally {
        removePath(root);
        removePath(outside);
    }
});
