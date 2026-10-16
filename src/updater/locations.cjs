/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { PluginError } = require('../errors.cjs');

// Where the two components live on this host, and how a directory proves it is
// one of them. The identity rules are the installer's, not new ones: the
// frontend manifest that the host itself reads, and the server package name.
//
// This test channel updates from the paired Luker forks below, never from
// whatever origin a copy happens to carry. The installed origin is read only
// to report a mismatch.

const FRONTEND_DIRECTORY = 'ST-Vertex-PayGo';
const SERVER_DIRECTORY = 'ST-Vertex-PayGo-Server';
const FRONTEND_DISPLAY_NAME = 'Vertex AI PayGo Tiers';
const SERVER_PACKAGE_NAME = 'st-vertex-paygo-server';
const METADATA_FILE = 'paygo-updater.json';

const OFFICIAL_REMOTES = Object.freeze({
    frontend: 'https://github.com/ReedSein/ST-Vertex-PayGo-Luker.git',
    server: 'https://github.com/ReedSein/ST-Vertex-PayGo-Server-Luker.git',
});

const DEFAULT_PLUGINS_PATH = 'plugins';
const DEFAULT_EXTENSIONS_PATH = 'public/scripts/extensions/third-party';
const DEFAULT_DATA_ROOT = 'data';

function readJsonFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/u, ''));
    } catch {
        return null;
    }
}

function isDirectory(target) {
    try {
        return fs.statSync(target).isDirectory();
    } catch {
        return false;
    }
}

function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Rejects a managed path that leaves the host root or crosses a symlink, the
// same way the installer refuses to operate through links.
function resolveWithinHost(rootDir, target) {
    const resolved = path.resolve(target);
    if (!inside(rootDir, resolved) || resolved === rootDir) {
        throw new PluginError(500, 'UPDATER_UNSAFE_PATH', `Refusing to manage a path outside the host root: ${resolved}`);
    }
    let cursor = rootDir;
    for (const part of path.relative(rootDir, resolved).split(path.sep)) {
        cursor = path.join(cursor, part);
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                throw new PluginError(500, 'UPDATER_UNSAFE_PATH', `Refusing to manage a path through a symlink: ${cursor}`);
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    return resolved;
}

function frontendIdentity(directory) {
    const manifest = readJsonFile(path.join(directory, 'manifest.json'));
    return Boolean(manifest) && manifest.display_name === FRONTEND_DISPLAY_NAME;
}

function serverIdentity(directory) {
    const pkg = readJsonFile(path.join(directory, 'package.json'));
    return Boolean(pkg) && pkg.name === SERVER_PACKAGE_NAME;
}

function componentIdentity(component, directory) {
    return component === 'frontend' ? frontendIdentity(directory) : serverIdentity(directory);
}

// The loader requires the host's own YAML parser rather than bundling one.
// The host always has it: config.yaml is how it starts.
function readHostConfig(rootDir, { requireFrom = createRequire } = {}) {
    const configPath = path.join(rootDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        return { values: {}, source: 'absent' };
    }
    let parse;
    try {
        parse = requireFrom(path.join(rootDir, 'package.json'))('yaml').parse;
    } catch (error) {
        throw new PluginError(
            500,
            'UPDATER_HOST_CONFIG_UNREADABLE',
            `The host YAML parser is unavailable, so the configured plugin and extension directories cannot be resolved: ${error?.message ?? error}`,
            { cause: error },
        );
    }
    let values;
    try {
        values = parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        // Parser messages may quote secret values from config.yaml.
        throw new PluginError(500, 'UPDATER_HOST_CONFIG_INVALID', 'config.yaml could not be parsed.', { cause: error });
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
        throw new PluginError(500, 'UPDATER_HOST_CONFIG_INVALID', 'config.yaml is not a YAML mapping.');
    }
    return { values, source: 'config', configPath };
}

function readStringOption(values, key) {
    const value = values?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

// Command-line overrides win over config.yaml, exactly as the host resolves
// them, and the host publishes them on globalThis at startup.
function resolveDirectories(rootDir, { commandLine = globalThis.COMMAND_LINE_ARGS, config = undefined } = {}) {
    const hostConfig = config ?? readHostConfig(rootDir);
    const values = hostConfig.values ?? {};
    const pluginsPath = readStringOption(commandLine, 'serverPluginsPath')
        ?? readStringOption(values, 'serverPluginsPath')
        ?? DEFAULT_PLUGINS_PATH;
    const extensionsPath = readStringOption(commandLine, 'globalExtensionsPath')
        ?? readStringOption(values, 'globalExtensionsPath')
        ?? DEFAULT_EXTENSIONS_PATH;
    const dataRoot = readStringOption(commandLine, 'dataRoot')
        ?? readStringOption(values, 'dataRoot')
        ?? DEFAULT_DATA_ROOT;
    return Object.freeze({
        rootDir,
        pluginsDirectory: resolveWithinHost(rootDir, path.resolve(rootDir, pluginsPath)),
        extensionsDirectory: resolveWithinHost(rootDir, path.resolve(rootDir, extensionsPath)),
        dataRootDirectory: path.resolve(rootDir, dataRoot),
        configSource: hostConfig.source,
    });
}

// Both install locations the host supports: the global third-party directory
// and every per-user extensions directory under the data root.
function extensionRoots(directories) {
    const roots = [directories.extensionsDirectory];
    if (isDirectory(directories.dataRootDirectory)) {
        for (const entry of fs.readdirSync(directories.dataRootDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            roots.push(path.join(directories.dataRootDirectory, entry.name, 'extensions'));
        }
    }
    return roots;
}

function locateComponent(component, directories) {
    const roots = component === 'frontend' ? extensionRoots(directories) : [directories.pluginsDirectory];
    const matches = [];
    for (const root of roots) {
        if (!isDirectory(root)) continue;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const candidate = path.join(root, entry.name);
            if (componentIdentity(component, candidate)) matches.push(resolveWithinHost(directories.rootDir, candidate));
        }
    }
    return matches.sort();
}

// The server plugin's own directory is authoritative: the host loaded us from
// it, which already reflects any command-line or configuration override.
function serverDirectory() {
    return path.resolve(__dirname, '..', '..');
}

function metadataPath(directory) {
    return path.join(directory, '.git', METADATA_FILE);
}

module.exports = {
    DEFAULT_DATA_ROOT,
    DEFAULT_EXTENSIONS_PATH,
    DEFAULT_PLUGINS_PATH,
    FRONTEND_DIRECTORY,
    METADATA_FILE,
    OFFICIAL_REMOTES,
    SERVER_DIRECTORY,
    componentIdentity,
    extensionRoots,
    frontendIdentity,
    inside,
    isDirectory,
    locateComponent,
    metadataPath,
    readHostConfig,
    resolveDirectories,
    resolveWithinHost,
    serverDirectory,
    serverIdentity,
};
