/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { BridgeStateStore, MAX_STATE_BYTES } = require('../src/bridge-state-store.cjs');
const { createOpenAIBridge } = require('../src/openai-bridge.cjs');
const { createLoopbackTransport } = require('../src/loopback-server.cjs');
const connection = { source: 'makersuite', model: 'gemini-2.5-flash' };
function response() { return { code: 200, set() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function owner(root, handle = 'alice') { return { user: { directories: { root }, profile: { handle } } }; }
function runtime(credentials = new Map()) { return {
    resolveOpenAIConnection(request, selected) {
        const credential = credentials.get(request.user.directories.root) || 'test-google-key';
        return { connection: selected, ...(selected.secretId ? {} : { credentialSnapshot: credential }), logCredential: credential };
    },
    async getOpenAIConfig() { return { target: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', headers: { Authorization: 'Bearer test-google-key' } }; },
}; }
async function update(bridge, user, body) { const result = response(); await bridge.update({ ...user, body }, result); return result; }
async function get(bridge, user) { const result = response(); await bridge.get(user, result); return result.body; }
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-state-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const user = owner(root); const store = new BridgeStateStore(); const host = runtime();
    const bridge = createOpenAIBridge({ stRuntime: host, stateStore: store }); bridge.setBaseUrl('http://127.0.0.1:1234');
    t.after(() => bridge.close()); return { root, user, store, host, bridge };
}
test('headless restart restores enabled bridge, same key and fixed connection; off survives restart', async t => {
    const f = await fixture(t);
    const enabled = await update(f.bridge, f.user, { enabled: true, connection, debugLocalAccess: true });
    assert.equal(enabled.code, 200);
    const disk = await fs.readFile(f.store.file(f.user.user.directories), 'utf8');
    assert.equal(disk.includes('test-google-key'), false);
    if (process.platform !== 'win32') assert.equal((await fs.stat(f.store.file(f.user.user.directories))).mode & 0o777, 0o600);
    f.bridge.close();
    const restored = createOpenAIBridge({ stRuntime: f.host, stateStore: f.store, upstreamRequest(_target, _options, callback) {
        const request = new PassThrough(); request.setTimeout = () => request;
        request.on('finish', () => { const reply = new PassThrough(); reply.statusCode = 200; reply.headers = {}; callback(reply); reply.end('{"data":[{"id":"gemini-2.5-flash"}]}'); });
        return request;
    } });
    const listener = createLoopbackTransport({ openaiBridge: restored }); await listener.start(); restored.setBaseUrl(listener.baseUrl);
    t.after(async () => { restored.close(); await listener.close(); });
    const failures = []; await restored.restore([f.user], error => failures.push(error));
    assert.deepEqual(failures, []);
    const state = await get(restored, f.user);
    assert.equal(state.enabled, true); assert.equal(state.apiKey, enabled.body.apiKey); assert.equal(state.debugLocalAccess, true);
    assert.deepEqual(state.connection, connection);
    const models = await fetch(`${listener.baseUrl}/openai/v1/models`, { headers: { Authorization: `Bearer ${state.apiKey}` } });
    assert.equal(models.status, 200); await models.text();
    await update(restored, f.user, { enabled: false }); restored.close();
    const off = createOpenAIBridge({ stRuntime: f.host, stateStore: f.store }); off.setBaseUrl('http://127.0.0.1:1234');
    await off.restore([f.user]); assert.equal((await get(off, f.user)).enabled, false); off.close();
    assert.deepEqual(await f.store.read(f.user.user.directories), { schema: 1, enabled: false });
});
test('restore isolates users, missing state defaults off, and legacy changed credential fails closed', async t => {
    const f = await fixture(t); await update(f.bridge, f.user, { enabled: true, connection });
    const bob = owner(path.join(f.root, 'bob'), 'bob');
    await update(f.bridge, bob, { enabled: true, connection: { ...connection, secretId: 'fixed-id' } });
    const bobKey = (await get(f.bridge, bob)).apiKey; f.bridge.close();
    const credentials = new Map([[f.root, 'changed-active-key']]); const errors = [];
    const bridge = createOpenAIBridge({ stRuntime: runtime(credentials), stateStore: f.store }); bridge.setBaseUrl('http://127.0.0.1:1234');
    await bridge.restore([f.user, bob, owner(path.join(f.root, 'missing'))], error => errors.push(error));
    assert.deepEqual(errors, [{ code: 'BRIDGE_CREDENTIAL_CHANGED' }]);
    assert.equal((await get(bridge, f.user)).enabled, false);
    assert.equal((await get(bridge, f.user)).restorePending, true);
    assert.match((await get(bridge, f.user)).restoreError, /could not be restored/);
    assert.equal((await get(bridge, bob)).apiKey, bobKey);
    await update(bridge, f.user, { enabled: false }); assert.equal((await f.store.read(f.user.user.directories)).enabled, false);
    assert.equal((await get(bridge, f.user)).restorePending, undefined); bridge.close();
});

test('Vertex gateway policy and rotated bridge key survive restart without upstream authentication', async t => {
    const f = await fixture(t);
    const selected = { source: 'vertexai', model: 'gemini-2.5-pro', authMode: 'full', region: 'global', secretId: 'bound-account' };
    const authenticate = [];
    f.host.getOpenAIConfig = async (_request, _connection, enabled) => { authenticate.push(enabled); return {}; };
    const initial = await update(f.bridge, f.user, { enabled: true, connection: selected, mode: 'gemini', tierSource: 'independent', tier: 'flex', debugLocalAccess: true });
    const rotated = await update(f.bridge, f.user, { enabled: true, rotateKey: true });
    assert.equal(rotated.code, 200); assert.notEqual(rotated.body.apiKey, initial.body.apiKey);
    f.bridge.close();
    const restored = createOpenAIBridge({ stRuntime: f.host, stateStore: f.store }); restored.setBaseUrl('http://127.0.0.1:1234');
    t.after(() => restored.close());
    await restored.restore([f.user]);
    const state = await get(restored, f.user);
    assert.equal(state.enabled, true); assert.equal(state.apiKey, rotated.body.apiKey);
    assert.deepEqual(state.connection, selected);
    assert.equal(state.mode, 'gemini'); assert.equal(state.tierSource, 'independent');
    assert.equal(state.tier, 'flex'); assert.equal(state.effectiveTier, 'flex'); assert.equal(state.debugLocalAccess, true);
    assert.deepEqual(authenticate, [false, false, false]);
});
test('close during restoration preserves saved startup state without rewriting it', async t => {
    const f = await fixture(t); await update(f.bridge, f.user, { enabled: true, connection });
    const before = await fs.readFile(f.store.file(f.user.user.directories), 'utf8'); f.bridge.close();
    let release; let started; const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const host = runtime(); host.getOpenAIConfig = async () => { started(); await gate; return {}; };
    const bridge = createOpenAIBridge({ stRuntime: host, stateStore: f.store }); bridge.setBaseUrl('http://127.0.0.1:1234');
    const pending = bridge.restore([f.user]); await entered; bridge.close(); release(); await pending;
    assert.equal((await get(bridge, f.user)).enabled, false);
    assert.equal(await fs.readFile(f.store.file(f.user.user.directories), 'utf8'), before);
});
test('named credential restoration must not silently resolve another credential ID', async t => {
    const f = await fixture(t); await update(f.bridge, f.user, { enabled: true, connection: { ...connection, secretId: 'fixed-id' } }); f.bridge.close();
    const host = runtime(); host.resolveOpenAIConnection = () => ({ connection: { ...connection, secretId: 'other-id' } });
    const bridge = createOpenAIBridge({ stRuntime: host, stateStore: f.store }); bridge.setBaseUrl('http://127.0.0.1:1234');
    const errors = []; await bridge.restore([f.user], error => errors.push(error));
    assert.deepEqual(errors, [{ code: 'BRIDGE_CREDENTIAL_CHANGED' }]); assert.equal((await get(bridge, f.user)).enabled, false); bridge.close();
});
test('bounded corrupt state reports safe errors and can be disabled without reading it', async t => {
    const f = await fixture(t); await fs.mkdir(path.dirname(f.store.file(f.user.user.directories)), { recursive: true });
    for (const value of ['{"secret":"never-log-this"', 'x'.repeat(MAX_STATE_BYTES + 1), '{"schema":2,"enabled":true}']) {
        await fs.writeFile(f.store.file(f.user.user.directories), value);
        const errors = []; await f.bridge.restore([f.user], error => errors.push(error));
        assert.deepEqual(errors, [{ code: 'BRIDGE_STATE_INVALID' }]); assert.equal((await get(f.bridge, f.user)).enabled, false);
    }
    const disabled = await update(f.bridge, f.user, { enabled: false }); assert.equal(disabled.code, 200);
    assert.deepEqual(await f.store.read(f.user.user.directories), { schema: 1, enabled: false });
});
test('write failure cannot publish changed connection/key or revoke existing bridge', async t => {
    const f = await fixture(t); const original = await update(f.bridge, f.user, { enabled: true, connection });
    const write = f.store.write.bind(f.store); f.store.write = async () => { throw new Error('private-disk-error'); };
    const failed = await update(f.bridge, f.user, { enabled: true, rotateKey: true });
    assert.equal(failed.code, 500); assert.equal(JSON.stringify(failed.body).includes('private-disk-error'), false);
    assert.equal((await get(f.bridge, f.user)).apiKey, original.body.apiKey);
    f.store.write = write;
});
test('superseded save cannot revive after disabling, and close during save rolls back pending enable', async t => {
    for (const close of [false, true]) {
        const f = await fixture(t); let release; let entered;
        const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
        const write = f.store.write.bind(f.store); let first = true;
        f.store.write = async (...args) => { if (first) { first = false; entered(); await gate; } await write(...args); };
        const enabling = update(f.bridge, f.user, { enabled: true, connection }); await started;
        let disabling;
        if (close) f.bridge.close(); else disabling = update(f.bridge, f.user, { enabled: false });
        release(); assert.equal((await enabling).code, 409);
        if (disabling) assert.equal((await disabling).code, 200);
        assert.deepEqual(await f.store.read(f.user.user.directories), { schema: 1, enabled: false });
        assert.equal((await get(f.bridge, f.user)).enabled, false);
    }
});
test('close during management after failed restoration preserves original enabled disk state', async t => {
    for (const enabled of [true, false]) {
        const f = await fixture(t); await update(f.bridge, f.user, { enabled: true, connection }); f.bridge.close();
        const original = await f.store.read(f.user.user.directories);
        const host = runtime(new Map([[f.root, 'changed-key']]));
        const bridge = createOpenAIBridge({ stRuntime: host, stateStore: f.store }); bridge.setBaseUrl('http://127.0.0.1:1234');
        await bridge.restore([f.user]); assert.equal((await get(bridge, f.user)).restorePending, true);
        let release; let started; const gate = new Promise(resolve => { release = resolve; });
        const entered = new Promise(resolve => { started = resolve; }); const write = f.store.write.bind(f.store); let first = true;
        f.store.write = async (...args) => { if (first) { first = false; started(); await gate; } await write(...args); };
        const changing = update(bridge, f.user, { enabled, ...(enabled ? { connection } : {}) }); await entered;
        bridge.close(); release(); assert.equal((await changing).code, 409);
        assert.deepEqual(await f.store.read(f.user.user.directories), original);
    }
});
test('late policy reads cannot return a revoked key after a newer disable', async t => {
    const f = await fixture(t); let release; let started;
    const gate = new Promise(resolve => { release = resolve; }); const entered = new Promise(resolve => { started = resolve; });
    f.host.readSavedSettings = async () => { started(); await gate; return { main_api: 'openai', oai_settings: { chat_completion_source: 'vertexai' } }; };
    const enabling = update(f.bridge, f.user, { enabled: true, connection: { source: 'vertexai', model: 'gemini-2.5-flash', authMode: 'full', region: 'global' }, tierSource: 'follow' });
    await entered;
    const getting = get(f.bridge, f.user);
    assert.equal((await update(f.bridge, f.user, { enabled: false })).code, 200);
    release(); assert.equal((await enabling).code, 409);
    const state = await getting; assert.equal(state.enabled, false); assert.equal(state.apiKey, null);
});
