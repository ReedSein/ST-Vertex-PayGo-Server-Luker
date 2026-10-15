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
    componentIdentity,
    locateComponent,
    readHostConfig,
    resolveDirectories,
    resolveWithinHost,
} = require('../src/updater/locations.cjs');

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
}

// A host fixture with both install locations and one per-user copy, matching
// the layout the host itself uses.
function makeHost(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-host-'));
    writeJson(path.join(root, 'package.json'), { name: 'luker', version: '2.8.0' });
    writeJson(path.join(root, 'plugins', 'ST-Vertex-PayGo-Server', 'package.json'), { name: 'st-vertex-paygo-server' });
    writeJson(path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo', 'manifest.json'), {
        display_name: 'Vertex AI PayGo Tiers',
    });
    if (options.config !== undefined) {
        fs.writeFileSync(path.join(root, 'config.yaml'), options.config);
    }
    return root;
}

function cleanup(root) {
    fs.rmSync(root, { recursive: true, force: true });
}

test('identity comes from the manifest and package names the host already reads', () => {
    const root = makeHost();
    try {
        assert.equal(componentIdentity('frontend', path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo')), true);
        assert.equal(componentIdentity('frontend', path.join(root, 'public', 'scripts', 'extensions', 'third-party')), false);
        assert.equal(componentIdentity('server', path.join(root, 'plugins', 'ST-Vertex-PayGo-Server')), true);
        assert.equal(componentIdentity('server', path.join(root, 'plugins')), false);
    } finally {
        cleanup(root);
    }
});

test('both install locations are found, including per-user copies', () => {
    const root = makeHost();
    try {
        const userCopy = path.join(root, 'data', 'alice', 'extensions', 'ST-Vertex-PayGo');
        writeJson(path.join(userCopy, 'manifest.json'), { display_name: 'Vertex AI PayGo Tiers' });
        const directories = resolveDirectories(root, { commandLine: null, config: { values: {}, source: 'absent' } });
        assert.deepEqual(locateComponent('frontend', directories), [
            path.join(root, 'data', 'alice', 'extensions', 'ST-Vertex-PayGo'),
            path.join(root, 'public', 'scripts', 'extensions', 'third-party', 'ST-Vertex-PayGo'),
        ].sort());
        assert.deepEqual(locateComponent('server', directories), [path.join(root, 'plugins', 'ST-Vertex-PayGo-Server')]);
    } finally {
        cleanup(root);
    }
});

test('command-line overrides win over config.yaml, which wins over defaults', () => {
    const root = makeHost({ config: JSON.stringify({ serverPluginsPath: './cfg-plugins', globalExtensionsPath: './cfg-ext', dataRoot: './cfg-data' }) });
    try {
        const fromConfig = resolveDirectories(root, { commandLine: null, config: { values: { serverPluginsPath: './cfg-plugins', globalExtensionsPath: './cfg-ext', dataRoot: './cfg-data' }, source: 'config' } });
        assert.equal(fromConfig.pluginsDirectory, path.join(root, 'cfg-plugins'));
        assert.equal(fromConfig.extensionsDirectory, path.join(root, 'cfg-ext'));
        assert.equal(fromConfig.dataRootDirectory, path.join(root, 'cfg-data'));

        const fromCommandLine = resolveDirectories(root, {
            commandLine: { serverPluginsPath: './cli-plugins', globalExtensionsPath: './cli-ext', dataRoot: './cli-data' },
            config: { values: { serverPluginsPath: './cfg-plugins' }, source: 'config' },
        });
        assert.equal(fromCommandLine.pluginsDirectory, path.join(root, 'cli-plugins'));
        assert.equal(fromCommandLine.extensionsDirectory, path.join(root, 'cli-ext'));
        assert.equal(fromCommandLine.dataRootDirectory, path.join(root, 'cli-data'));

        const defaults = resolveDirectories(root, { commandLine: null, config: { values: {}, source: 'absent' } });
        assert.equal(defaults.pluginsDirectory, path.join(root, 'plugins'));
        assert.equal(defaults.extensionsDirectory, path.join(root, 'public', 'scripts', 'extensions', 'third-party'));
        assert.equal(defaults.dataRootDirectory, path.join(root, 'data'));
    } finally {
        cleanup(root);
    }
});

test('managed paths outside the host root or through a symlink are refused', () => {
    const root = makeHost();
    try {
        assert.throws(() => resolveWithinHost(root, path.join(root, '..', 'elsewhere')), error => error?.code === 'UPDATER_UNSAFE_PATH');
        assert.throws(() => resolveWithinHost(root, root), error => error?.code === 'UPDATER_UNSAFE_PATH');
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-outside-'));
        try {
            fs.symlinkSync(outside, path.join(root, 'linked'));
            assert.throws(() => resolveWithinHost(root, path.join(root, 'linked', 'payload')), error => error?.code === 'UPDATER_UNSAFE_PATH');
        } finally {
            cleanup(outside);
        }
    } finally {
        cleanup(root);
    }
});

test('the host config is read with the host parser and fails loudly when unusable', () => {
    const root = makeHost({ config: JSON.stringify({ globalExtensionsPath: './from-config' }) });
    try {
        // The fixture writes JSON, which is valid YAML, so a minimal parser stands in
        // for the host module without changing what is being tested. requireFrom has
        // the createRequire shape: a path in, a require function out.
        const requireFrom = () => name => {
            if (name !== 'yaml') throw new Error(`unexpected module: ${name}`);
            return { parse: text => JSON.parse(text) };
        };
        const read = readHostConfig(root, { requireFrom });
        assert.equal(read.source, 'config');
        assert.equal(read.values.globalExtensionsPath, './from-config');
        assert.equal(resolveDirectories(root, { commandLine: null, config: read }).extensionsDirectory, path.join(root, 'from-config'));

        assert.throws(
            () => readHostConfig(root, { requireFrom: () => { throw new Error('no yaml here'); } }),
            error => error?.code === 'UPDATER_HOST_CONFIG_UNREADABLE',
        );

        const broken = makeHost({ config: '{{ not yaml' });
        try {
            assert.throws(
                () => readHostConfig(broken, { requireFrom: () => () => ({ parse: text => JSON.parse(text) }) }),
                error => error?.code === 'UPDATER_HOST_CONFIG_INVALID',
            );
        } finally {
            cleanup(broken);
        }
    } finally {
        cleanup(root);
    }
});

test('a host without config.yaml falls back to the documented defaults', () => {
    const root = makeHost();
    try {
        assert.equal(readHostConfig(root).source, 'absent');
    } finally {
        cleanup(root);
    }
});

test('component discovery refuses a matching installation reached through a symlink', () => {
    const root = makeHost();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paygo-outside-'));
    try {
        const frontend = path.join(root, 'public/scripts/extensions/third-party/ST-Vertex-PayGo');
        fs.renameSync(frontend, path.join(outside, 'frontend'));
        fs.symlinkSync(path.join(outside, 'frontend'), frontend);
        const directories = resolveDirectories(root, { commandLine: null, config: { values: {}, source: 'absent' } });
        assert.throws(() => locateComponent('frontend', directories), error => error.code === 'UPDATER_UNSAFE_PATH');
    } finally {
        cleanup(root);
        cleanup(outside);
    }
});
