"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const register = require("../fp2");

function makeAdmin(dependencies) {
    const routes = new Map();
    let requestedPermission;
    const RED = {
        auth: {
            needsPermission(permission) {
                requestedPermission = permission;
                return (_req, _res, next) => next();
            },
        },
        httpAdmin: {
            get(url, ...handlers) { routes.set(`GET ${url}`, handlers.at(-1)); },
            post(url, ...handlers) { routes.set(`POST ${url}`, handlers.at(-1)); },
        },
    };
    register.registerAdminRoutes(RED, dependencies);
    return { routes, get permission() { return requestedPermission; } };
}

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.resolve?.(body); },
    };
}

function makeRuntime(Client, dependencies, signals = new EventEmitter()) {
    let constructor;
    const RED = {
        auth: { needsPermission: () => (_req, _res, next) => next() },
        httpAdmin: { get() {}, post() {} },
        nodes: {
            registerType(name, implementation) { assert.equal(name, "fp2"); constructor = implementation; },
            createNode(node, config) {
                const events = new EventEmitter();
                node.credentials = config.credentials;
                node.on = events.on.bind(events);
                node.emit = events.emit.bind(events);
                node.messages = [];
                node.statuses = [];
                node.send = message => node.messages.push(message);
                node.warn = message => signals.emit("warning", message);
                node.status = status => {
                    node.statuses.push(status);
                    if (status.fill === "green") signals.emit("ready");
                };
            },
        },
    };
    register(RED, Client, dependencies);
    return constructor;
}

test("registers pairing routes behind the Node-RED flow-write permission", async () => {
    let closed = false;
    let startedPin;
    const service = {
        name: "FP2._hap._tcp.local.",
        id: "AA:BB:CC:DD:EE:FF",
        address: "192.0.2.10",
        port: 12345,
        md: "FP2",
        availableToPair: true,
    };
    const admin = makeAdmin({
        discoveryTimeout: 1,
        createDiscovery: () => ({
            browser: { list: () => [{ txt: { id: service.id }, host: "fp2.local." }] },
            start() {},
            stop() {},
            list: () => [service],
            getPairMethod: async () => 7,
        }),
        createClient: (...args) => ({
            args,
            async startPairing(method) { assert.equal(method, 7); return { handshake: true }; },
            async finishPairing(data, pin) {
                assert.deepEqual(data, { handshake: true });
                startedPin = pin;
            },
            getLongTermData: () => ({
                AccessoryPairingID: service.id,
                AccessoryLTPK: "a".repeat(64),
                iOSDevicePairingID: "controller",
                iOSDeviceLTSK: "b".repeat(64),
                iOSDeviceLTPK: "c".repeat(64),
            }),
            async close() { closed = true; },
        }),
    });

    assert.equal(admin.permission, "flows.write");
    const discoveryResponse = response();
    const discoveryDone = new Promise(resolve => { discoveryResponse.resolve = resolve; });
    admin.routes.get("GET /fp2/pairing/discover")({}, discoveryResponse);
    const discovered = await discoveryDone;
    assert.equal(discovered.devices.length, 1);
    assert.equal(discovered.devices[0].address, service.address);

    const pairingResponse = response();
    await admin.routes.get("POST /fp2/pairing/pair")({
        body: { token: discovered.devices[0].token, pin: "123-45-678" },
    }, pairingResponse);
    assert.equal(startedPin, "123-45-678");
    assert.equal(pairingResponse.body.pairing.host, "fp2.local.");
    assert.equal(Object.hasOwn(pairingResponse.body.pairing, "address"), false);
    assert.equal(pairingResponse.body.pairing.port, service.port);
    assert.equal(closed, true);
});

test("rejects invalid or stale pairing requests without opening a client", async () => {
    let clientCreated = false;
    const admin = makeAdmin({
        discoveryTimeout: 1,
        createDiscovery: () => ({ start() {}, stop() {}, list: () => [], getPairMethod: async () => 1 }),
        createClient: () => { clientCreated = true; },
    });
    const invalidResponse = response();
    await admin.routes.get("POST /fp2/pairing/pair")({ body: { token: "missing", pin: "12345678" } }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(clientCreated, false);
});

test("editor declares pairing as a Node-RED credential and provides pairing controls", () => {
    const metadata = require("../package.json");
    const html = fs.readFileSync(path.resolve(__dirname, "../fp2.html"), "utf8");
    const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/);
    assert.ok(script);
    let definition;
    vm.runInNewContext(script[1], {
        RED: { nodes: { registerType(name, config) {
            assert.equal(name, "fp2");
            definition = config;
        } } },
    });
    assert.equal(metadata["node-red"].nodes.fp2, "fp2.js");
    assert.equal(definition.credentials.pairing.type, "password");
    assert.equal(definition.inputs, 0);
    assert.equal(definition.outputs, 1);
    const pairingInputId = `node-input-${Object.keys(definition.credentials)[0]}`;
    assert.ok(html.includes(`<input type="hidden" id="${pairingInputId}">`));
    assert.ok(!html.includes(`for="${pairingInputId}"`));
    assert.ok(!html.includes("Pairing existant"));
    assert.ok(!html.includes("aiohomekit"));
    assert.ok(script[1].includes(`$("#${pairingInputId}")`));
    assert.ok(!html.includes("node-input-credentials-pairing"));
    assert.ok(html.includes("fp2/pairing/discover"));
    assert.ok(html.includes("fp2/pairing/pair"));
});

test("maps zones, global presence, and illuminance from event-capable characteristics", () => {
    const database = { accessories: [{ aid: 1, services: [
        { characteristics: [{ type: "23", value: "Global Presence" }, { type: "71", iid: 10, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Bureau" }, { type: "71", iid: 20, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Bureau" }, { type: "71", iid: 21, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Luminosity" }, { type: "6B", iid: 30, perms: ["ev"] }] },
        { characteristics: [{ type: "71", iid: 30, perms: ["pr"] }] },
    ] }] };
    const mapping = register.buildEntities(database, "fp2");
    assert.deepEqual([...mapping.entities.keys()], ["1.10", "1.20", "1.21", "1.30"]);
    assert.equal(mapping.entities.get("1.10").topic, "fp2/presence");
    assert.equal(mapping.entities.get("1.20").topic, "fp2/zone/bureau");
    assert.equal(mapping.entities.get("1.21").topic, "fp2/zone/bureau-1-21");
    assert.equal(mapping.entities.get("1.30").topic, "fp2/illuminance");
    assert.equal(mapping.unresolved.length, 1);
});

test("does not guess an ambiguous global presence or illuminance sensor", () => {
    const database = { accessories: [{ aid: 2, services: [
        { characteristics: [{ type: "23", value: "Cellier" }, { type: "71", iid: 10, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Couloir" }, { type: "71", iid: 20, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Lux A" }, { type: "6B", iid: 30, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Lux B" }, { type: "6B", iid: 40, perms: ["ev"] }] },
    ] }] };
    const mapping = register.buildEntities(database);
    assert.equal([...mapping.entities.values()].filter(entity => entity.kind === "presence").length, 0);
    assert.equal([...mapping.entities.values()].filter(entity => entity.kind === "illuminance").length, 0);
    assert.equal(mapping.warnings.length, 2);
});

test("resolves the stored hostname on connection and reconnection and emits only entity changes", { timeout: 5000 }, async () => {
    const signals = new EventEmitter();
    let client;
    const database = { accessories: [{ aid: 1, services: [
        { characteristics: [{ type: "23", value: "Global Presence" }, { type: "71", iid: 10, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Bureau" }, { type: "71", iid: 20, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Luminosity" }, { type: "6B", iid: 30, perms: ["ev"] }] },
    ] }] };
    const mapping = register.buildEntities(database);
    class FakeClient extends EventEmitter {
        constructor(...args) { super(); client = this; this.args = args; }
        async getAccessories() { return database; }
        async getCharacteristics() {
            return { characteristics: [
                { aid: 1, iid: 10, value: 0 },
                { aid: 1, iid: 20, value: 0 },
                { aid: 1, iid: 30, value: 35.5 },
            ] };
        }
        async subscribeCharacteristics(keys) { this.keys = keys; return {}; }
        async close() { this.closed = true; }
    }
    let lookups = 0;
    const constructor = makeRuntime(FakeClient, {
        createDiscovery: () => ({}),
        lookup: async (host, options) => {
            assert.equal(host, "fp2.local.");
            assert.deepEqual(options, { family: 4 });
            lookups += 1;
            return { address: lookups === 1 ? "192.0.2.20" : "192.0.2.21" };
        },
    }, signals);
    const ready = once(signals, "ready");
    const pairing = {
        AccessoryPairingID: "AA:BB:CC:DD:EE:FF",
        host: "fp2.local.",
        port: 12345,
    };
    const node = new constructor({
        topicPrefix: "fp2",
        credentials: { pairing: JSON.stringify(pairing) },
    });
    try {
        await ready;
        assert.equal(node.messages.length, 0);
        assert.equal(client.args[0], pairing.AccessoryPairingID);
        assert.equal(client.args[1], "192.0.2.20");
        assert.equal(client.args[2], pairing.port);
        assert.deepEqual(client.args[3], pairing);
        assert.deepEqual(client.keys, [...mapping.entities.keys()]);

        const rawEvent = {
            futureField: "preserved",
            characteristics: [
            { aid: 1, iid: 10, value: 1 },
            { aid: 1, iid: 20, value: true },
            { aid: 1, iid: 30, value: 36.5 },
            ],
        };
        client.emit("event", rawEvent);
        client.emit("event", { characteristics: [
            { aid: 1, iid: 10, value: true },
            { aid: 1, iid: 20, value: 1 },
            { aid: 1, iid: 30, value: 36.5 },
        ] });
        assert.deepEqual(node.messages.map(message => message.topic), [
            "fp2/presence",
            "fp2/zone/bureau",
            "fp2/illuminance",
        ]);
        assert.deepEqual(node.messages.map(message => message.payload), [true, true, 36.5]);
        assert.ok(node.messages.every(message => assert.deepEqual(message.raw, rawEvent) === undefined));
        assert.ok(node.messages.every(message => message.kind && message.aid === "1" && message.iid));
        const previousClient = client;
        const reconnected = once(signals, "ready");
        previousClient.emit("event-disconnect");
        await reconnected;
        assert.equal(lookups, 2);
        assert.equal(previousClient.closed, true);
        assert.equal(client.args[1], "192.0.2.21");
        assert.equal(node.messages.length, 3);
    } finally {
        await new Promise(resolve => node.emit("close", false, resolve));
    }
    assert.equal(client.closed, true);
});

test("keeps legacy IP credentials and prioritizes manual IP and hostname overrides", async context => {
    for (const scenario of [
        { name: "legacy IP", config: {}, address: "192.0.2.10", calls: 0 },
        { name: "manual IP", config: { host: "192.0.2.30", port: "54321" }, address: "192.0.2.30", calls: 0 },
        { name: "manual hostname", config: { host: "override.local" }, address: "192.0.2.40", calls: 1 },
    ]) {
        await context.test(scenario.name, async () => {
            const signals = new EventEmitter();
            let args;
            let lookups = 0;
            class FakeClient extends EventEmitter {
                constructor(...values) { super(); args = values; }
                async getAccessories() { throw new Error("test stop"); }
                async close() {}
            }
            const constructor = makeRuntime(FakeClient, {
                lookup: async host => {
                    assert.equal(host, "override.local");
                    lookups += 1;
                    return { address: "192.0.2.40" };
                },
            }, signals);
            const warned = once(signals, "warning");
            const node = new constructor({
                ...scenario.config,
                credentials: { pairing: JSON.stringify({
                    accessoryId: "AA:BB:CC:DD:EE:FF",
                    address: "192.0.2.10",
                    port: 12345,
                }) },
            });
            try {
                await warned;
                assert.equal(args[1], scenario.address);
                assert.equal(args[2], Number(scenario.config.port || 12345));
                assert.equal(lookups, scenario.calls);
            } finally {
                await new Promise(resolve => node.emit("close", false, resolve));
            }
        });
    }
});

test("retries failed name resolution through the existing warning path", { timeout: 5000 }, async () => {
    const signals = new EventEmitter();
    let lookups = 0;
    let clients = 0;
    class FakeClient extends EventEmitter {
        constructor() { super(); clients += 1; }
        async getAccessories() { throw new Error("test stop"); }
        async close() {}
    }
    const constructor = makeRuntime(FakeClient, {
        lookup: async () => {
            lookups += 1;
            if (lookups === 1) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
            return { address: "192.0.2.50" };
        },
    }, signals);
    const warned = once(signals, "warning");
    const node = new constructor({
        credentials: { pairing: JSON.stringify({ host: "fp2.local", port: 12345 }) },
    });
    try {
        assert.deepEqual(await warned, ["Erreur FP2 : ENOTFOUND"]);
        assert.equal(clients, 0);
        assert.equal(node.statuses.at(-1).text, "deconnecte");
        const retried = once(signals, "warning");
        assert.deepEqual(await retried, ["test stop"]);
        assert.equal(lookups, 2);
        assert.equal(clients, 1);
        assert.equal(node.messages.length, 0);
    } finally {
        await new Promise(resolve => node.emit("close", false, resolve));
    }
});

test("does not open a connection when closed during name resolution", async () => {
    let finishLookup;
    let clients = 0;
    const lookupDone = new Promise(resolve => { finishLookup = resolve; });
    const constructor = makeRuntime(class { constructor() { clients += 1; } }, {
        lookup: () => lookupDone,
    });
    const node = new constructor({
        credentials: { pairing: JSON.stringify({ host: "fp2.local", port: 12345 }) },
    });
    await new Promise(resolve => node.emit("close", false, resolve));
    finishLookup({ address: "192.0.2.60" });
    await lookupDone;
    assert.equal(clients, 0);
    assert.equal(node.messages.length, 0);
});