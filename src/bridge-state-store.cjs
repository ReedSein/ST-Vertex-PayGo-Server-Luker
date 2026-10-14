/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PluginError } = require('./errors.cjs');
const MAX_STATE_BYTES = 16 * 1024;
function validateSavedState(value) {
    const fields = ['schema', 'enabled', 'key', 'connection', 'credentialFingerprint', 'mode', 'tierSource', 'tier', 'debugLocalAccess'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 || typeof value.enabled !== 'boolean'
        || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid bridge state');
    if (!value.enabled) {
        if (Object.keys(value).some(key => !['schema', 'enabled'].includes(key))) throw new Error('Invalid disabled bridge state');
        return value;
    }
    if (typeof value.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.key) || typeof value.debugLocalAccess !== 'boolean'
        || !value.connection || typeof value.connection !== 'object' || Array.isArray(value.connection)
        || Object.keys(value.connection).some(key => !['source', 'model', 'authMode', 'region', 'secretId'].includes(key))
        || Object.values(value.connection).some(item => typeof item !== 'string')
        || !['openai', 'gemini'].includes(value.mode) || !['independent', 'follow'].includes(value.tierSource)
        || !['standard', 'flex', 'priority'].includes(value.tier)
        || (value.connection.secretId ? value.credentialFingerprint !== undefined : !/^[a-f0-9]{64}$/u.test(value.credentialFingerprint ?? '')))
        throw new Error('Invalid enabled bridge state');
    return value;
}
class BridgeStateStore {
    file(directories) {
        if (typeof directories?.root !== 'string' || !directories.root) throw new Error('Authenticated user root required');
        return path.join(directories.root, 'vertex-paygo', 'openai-bridge-state.json');
    }
    async read(directories) {
        let handle;
        try {
            handle = await fs.open(this.file(directories), 'r');
            const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
            let size = 0;
            while (size < bytes.length) {
                const result = await handle.read(bytes, size, bytes.length - size, null);
                if (!result.bytesRead) break;
                size += result.bytesRead;
            }
            if (size > MAX_STATE_BYTES) throw new Error('State exceeds bound');
            return validateSavedState(JSON.parse(bytes.subarray(0, size).toString('utf8')));
        } catch (cause) {
            if (cause.code === 'ENOENT') return null;
            throw new PluginError(500, 'BRIDGE_STATE_INVALID', 'The saved bridge configuration could not be read. Disable or configure the bridge again.');
        } finally { await handle?.close(); }
    }
    async write(directories, value) {
        const file = this.file(directories);
        let temporary;
        try {
            validateSavedState(value);
            const serialized = JSON.stringify(value);
            if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error('State exceeds bound');
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            temporary = `${file}.${randomUUID()}.tmp`;
            await fs.writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
            await fs.rename(temporary, file);
        } catch {
            throw new PluginError(500, 'BRIDGE_STATE_WRITE_FAILED', 'The bridge configuration could not be saved.');
        } finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
    }
}
module.exports = { BridgeStateStore, validateSavedState, MAX_STATE_BYTES };
