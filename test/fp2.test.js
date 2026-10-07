"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");

const VALID_PAIRING = {
    name: "FP2",
    AccessoryPairingID: "AA:BB:CC:DD:EE:FF",
    AccessoryLTPK: "a".repeat(64),
    iOSDevicePairingID: "controller",
    iOSDeviceLTSK: "b".repeat(64),
    iOSDeviceLTPK: "c".repeat(64),
};
const fakes = {};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === "hap-controller") {
        return {
            HttpClient: function (...args) { return new fakes.HttpClient(...args); },
            IPDiscovery: function () { return fakes.discovery; },
        };
    }
    if (/[\\/]dnssd[\\/]/.test(request)) {
        return { resolveService: (...args) => fakes.resolveService(...args) };
    }
    return originalLoad.call(this, request, ...rest);
};
const register = require("../fp2");

function makeRED(signals = new EventEmitter()) {
    const routes = new Map();
    let requestedPermission;
    let constructor;
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
                node.log = () => {};
                node.status = status => {
                    node.statuses.push(status);
                    if (status.fill === "green") signals.emit("ready");
                };
            },
        },
    };
    register(RED);
    return { routes, constructor, get permission() { return requestedPermission; } };
}

function response() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.resolve?.(body); },
    };
}

function makeRuntime(Client, resolveService, signals) {
    fakes.HttpClient = Client;
    fakes.resolveService = resolveService;
    return makeRED(signals).constructor;
}

async function mapEvent(database, event) {
    const signals = new EventEmitter();
    const warnings = [];
    signals.on("warning", message => warnings.push(message));
    let client;
    class FakeClient extends EventEmitter {
        constructor() { super(); client = this; }
        async getAccessories() { return database; }
        async getCharacteristics() { return { characteristics: [] }; }
        async subscribeCharacteristics() { return {}; }
        async close() {}
    }
    const constructor = makeRuntime(FakeClient, async () => ({ addresses: ["192.0.2.1"], port: 1 }), signals);
    const ready = once(signals, "ready");
    const node = new constructor({
        credentials: { pairing: JSON.stringify(VALID_PAIRING) },
    });
    try {
        await ready;
        client.emit("event", event);
        return { topics: node.messages.map(message => message.topic), warnings };
    } finally {
        await new Promise(resolve => node.emit("close", false, resolve));
    }
}

test("registers pairing routes behind the Node-RED flow-write permission", async t => {
    t.mock.timers.enable(["setTimeout"]);
    let closed = false;
    let startedPin;
    const service = {
        name: "Presence-Sensor-FP2-D61A",
        id: "AA:BB:CC:DD:EE:FF",
        address: "192.0.2.10",
        port: 12345,
        md: "FP2",
        availableToPair: true,
    };
    fakes.discovery = {
        start() {},
        stop() {},
        list: () => [service],
        getPairMethod: async () => 7,
    };
    fakes.HttpClient = function () {
        return {
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
        };
    };
    const admin = makeRED();

    assert.equal(admin.permission, "flows.write");
    const discoveryResponse = response();
    const discoveryDone = new Promise(resolve => { discoveryResponse.resolve = resolve; });
    admin.routes.get("GET /fp2/pairing/discover")({}, discoveryResponse);
    t.mock.timers.tick(5000);
    const discovered = await discoveryDone;
    assert.equal(discovered.devices.length, 1);
    assert.equal(discovered.devices[0].address, service.address);

    const pairingResponse = response();
    await admin.routes.get("POST /fp2/pairing/pair")({
        body: { token: discovered.devices[0].token, pin: "123-45-678" },
    }, pairingResponse);
    assert.equal(startedPin, "123-45-678");
    assert.equal(pairingResponse.body.pairing.name, service.name);
    assert.equal(pairingResponse.body.pairing.AccessoryPairingID, service.id);
    for (const field of ["host", "address", "port"]) {
        assert.equal(Object.hasOwn(pairingResponse.body.pairing, field), false);
    }
    assert.equal(closed, true);
});

test("rejects invalid or stale pairing requests without opening a client", async () => {
    let clientCreated = false;
    fakes.HttpClient = function () { clientCreated = true; };
    const admin = makeRED();
    const invalidResponse = response();
    await admin.routes.get("POST /fp2/pairing/pair")({ body: { token: "missing", pin: "12345678" } }, invalidResponse);
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(clientCreated, false);
});

test("rejects malformed or incomplete stored pairing data before connecting", async () => {
    const signals = new EventEmitter();
    const warnings = [];
    signals.on("warning", message => warnings.push(message));
    let resolutions = 0;
    const constructor = makeRuntime(class extends EventEmitter {}, async () => {
        resolutions += 1;
        return { addresses: ["192.0.2.1"], port: 1 };
    }, signals);

    for (const pairing of ["{", JSON.stringify({ name: "FP2" })]) {
        const node = new constructor({ credentials: { pairing } });
        assert.equal(node.statuses.at(-1).text, "invalid pairing");
        await new Promise(resolve => node.emit("close", false, resolve));
    }

    assert.equal(resolutions, 0);
    assert.deepEqual(warnings, Array(2).fill("Stored FP2 pairing data is invalid."));
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

test("maps zones, global presence, and illuminance from event-capable characteristics", async () => {
    const database = { accessories: [{ aid: 1, services: [
        { characteristics: [{ type: "23", value: "Global Presence" }, { type: "71", iid: 10, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Bureau" }, { type: "71", iid: 20, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Bureau" }, { type: "71", iid: 21, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Luminosity" }, { type: "6B", iid: 30, perms: ["ev"] }] },
        { characteristics: [{ type: "71", iid: 31, perms: ["pr"] }] },
    ] }] };
    const { topics, warnings } = await mapEvent(database, { characteristics: [
        { aid: 1, iid: 10, value: 1 },
        { aid: 1, iid: 20, value: 1 },
        { aid: 1, iid: 21, value: 1 },
        { aid: 1, iid: 30, value: 50 },
        { aid: 1, iid: 31, value: 1 },
    ] });
    assert.deepEqual(topics, ["fp2/presence", "fp2/zone/bureau", "fp2/zone/bureau-1-21", "fp2/illuminance"]);
    assert.deepEqual(warnings, []);
});

test("does not guess an ambiguous global presence or illuminance sensor", async () => {
    const database = { accessories: [{ aid: 2, services: [
        { characteristics: [{ type: "23", value: "Cellier" }, { type: "71", iid: 10, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Couloir" }, { type: "71", iid: 20, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Lux A" }, { type: "6B", iid: 30, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Lux B" }, { type: "6B", iid: 40, perms: ["ev"] }] },
    ] }] };
    const { topics, warnings } = await mapEvent(database, { characteristics: [
        { aid: 2, iid: 10, value: 1 },
        { aid: 2, iid: 20, value: 1 },
        { aid: 2, iid: 30, value: 10 },
        { aid: 2, iid: 40, value: 20 },
    ] });
    assert.deepEqual(topics, ["fp2/zone/cellier", "fp2/zone/couloir"]);
    assert.equal(warnings.length, 2);
});

test("resolves the FP2 service on connection and reconnection and emits only entity changes", { timeout: 5000 }, async () => {
    const signals = new EventEmitter();
    let client;
    const database = { accessories: [{ aid: 1, services: [
        { characteristics: [{ type: "23", value: "Global Presence" }, { type: "71", iid: 10, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Bureau" }, { type: "71", iid: 20, perms: ["ev"] }] },
        { characteristics: [{ type: "23", value: "Luminosity" }, { type: "6B", iid: 30, perms: ["ev"] }] },
    ] }] };
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
    let resolutions = 0;
    const constructor = makeRuntime(FakeClient, async name => {
        assert.equal(name, "Presence-Sensor-FP2-D61A._hap._tcp.local");
        resolutions += 1;
        return resolutions === 1
            ? { addresses: ["fe80::1", "192.0.2.20"], port: 60574 }
            : { addresses: ["192.0.2.21"], port: 62984 };
    }, signals);
    const ready = once(signals, "ready");
    const pairing = { ...VALID_PAIRING, name: "Presence-Sensor-FP2-D61A" };
    const node = new constructor({
        topicPrefix: "fp2",
        credentials: { pairing: JSON.stringify(pairing) },
    });
    try {
        await ready;
        assert.equal(node.messages.length, 0);
        assert.equal(client.args[0], pairing.AccessoryPairingID);
        assert.equal(client.args[1], "192.0.2.20");
        assert.equal(client.args[2], 60574);
        assert.deepEqual(client.args[3], pairing);
        assert.deepEqual(client.keys, ["1.10", "1.20", "1.30"]);

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
        assert.equal(resolutions, 2);
        assert.equal(previousClient.closed, true);
        assert.equal(client.args[1], "192.0.2.21");
        assert.equal(client.args[2], 62984);
        assert.equal(node.messages.length, 3);
    } finally {
        await new Promise(resolve => node.emit("close", false, resolve));
    }
    assert.equal(client.closed, true);
});

test("waits for the next attempt when the FP2 service does not resolve", { timeout: 5000 }, async () => {
    const signals = new EventEmitter();
    let resolutions = 0;
    let clients = 0;
    class FakeClient extends EventEmitter {
        constructor() { super(); clients += 1; }
        async getAccessories() { throw new Error("test stop"); }
        async close() {}
    }
    const constructor = makeRuntime(FakeClient, async () => {
        resolutions += 1;
        if (resolutions === 1) throw new Error("Resolve timed out");
        return { addresses: ["192.0.2.50"], port: 62984 };
    }, signals);
    const warned = once(signals, "warning");
    const node = new constructor({
        credentials: { pairing: JSON.stringify(VALID_PAIRING) },
    });
    try {
        assert.deepEqual(await warned, ["Resolve timed out"]);
        assert.equal(clients, 0);
        assert.equal(node.statuses.at(-1).text, "disconnected");
        const retried = once(signals, "warning");
        assert.deepEqual(await retried, ["test stop"]);
        assert.equal(resolutions, 2);
        assert.equal(clients, 1);
        assert.equal(node.messages.length, 0);
    } finally {
        await new Promise(resolve => node.emit("close", false, resolve));
    }
});

test("does not open a connection when closed during service resolution", async () => {
    let finishResolution;
    let clients = 0;
    const resolutionDone = new Promise(resolve => { finishResolution = resolve; });
    const constructor = makeRuntime(class { constructor() { clients += 1; } }, () => resolutionDone);
    const node = new constructor({
        credentials: { pairing: JSON.stringify(VALID_PAIRING) },
    });
    await new Promise(resolve => node.emit("close", false, resolve));
    finishResolution({ addresses: ["192.0.2.60"], port: 62984 });
    await resolutionDone;
    assert.equal(clients, 0);
    assert.equal(node.messages.length, 0);
});