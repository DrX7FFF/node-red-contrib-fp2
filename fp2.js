"use strict";

const PAIRING_CODE = /^\d{3}-\d{2}-\d{3}$/;
const RESOLVE_TIMEOUT_MS = 20000;
const PAIRING_FIELDS = [
    "name",
    "AccessoryPairingID",
    "AccessoryLTPK",
    "iOSDevicePairingID",
    "iOSDeviceLTSK",
    "iOSDeviceLTPK",
];
const WATCHED_TYPES = { "71": "presence", "6B": "illuminance" };
const NAME_TYPE = "23";
const INDEX_TYPE = "C8622A33";

function shortType(value) {
    return String(value || "").toUpperCase().split("-")[0].replace(/^0+/, "");
}

function buildConfig(database) {
    const accessories = database.accessories || [];
    if (accessories.length !== 1) {
        throw new Error(`Expected a single HAP accessory, found ${accessories.length}.`);
    }
    const accessory = accessories[0];
    const entities = {};
    for (const service of accessory.services || []) {
        const entity = { iid: null, type: null, name: null, index: null };
        for (const characteristic of service.characteristics || []) {
            const code = shortType(characteristic.type);
            switch (code) {
                case NAME_TYPE:
                    entity.name = characteristic.value;
                    break;
                case INDEX_TYPE:
                    entity.index = characteristic.value;
                    break;
                default:
                    if (WATCHED_TYPES[code] && characteristic.perms?.includes("ev")) {
                        entity.iid = String(characteristic.iid);
                        entity.type = WATCHED_TYPES[code];
                    }
            }
        }
        if (!entity.type) continue;
        entities[entity.iid] = entity;
    }
    return { aid: String(accessory.aid), entities };
}

function registerAdminRoutes(RED) {
    const discovered = new Map();
    const permission = RED.auth?.needsPermission
        ? RED.auth.needsPermission("flows.write")
        : (req, res, next) => next();

    RED.httpAdmin.get("/fp2/pairing/discover", permission, (_req, res) => {
        const { IPDiscovery } = require("hap-controller");
        const discovery = new IPDiscovery();
        discovered.clear();
        discovery.start();
        setTimeout(async () => {
            try {
                const hosts = new Map((discovery.browser?.list() || []).map(service =>
                    [service.txt.id, service.host]));
                const services = discovery.list().map(service => ({
                    ...service,
                    host: service.host || hosts.get(service.id),
                }));
                discovery.stop();
                const devices = await Promise.all(services.map(async service => {
                    const pairMethod = await discovery.getPairMethod(service);
                    discovered.set(service.id, {
                        service,
                        pairMethod,
                    });
                    return {
                        name: String(service.name || service.id),
                        id: service.id,
                        model: service.md || "",
                        address: service.address,
                        port: service.port,
                        availableToPair: Boolean(service.availableToPair),
                    };
                }));
                res.json({ devices });
            } catch (_error) {
                discovery.stop();
                res.status(500).json({ error: "HAP discovery failed." });
            }
        }, 5000);
    });

    RED.httpAdmin.post("/fp2/pairing/pair", permission, async (req, res) => {
        const { id, pin } = req.body || {};
        const entry = discovered.get(id);
        if (!entry) {
            res.status(400).json({ error: "Run discovery again before pairing." });
            return;
        }
        if (!entry.service.availableToPair) {
            res.status(409).json({ error: "This accessory is not available for pairing." });
            return;
        }
        if (typeof pin !== "string" || !PAIRING_CODE.test(pin)) {
            res.status(400).json({ error: "The HomeKit code must match the format XXX-XX-XXX." });
            return;
        }

        let client;
        try {
            const service = entry.service;
            if (!service.name) {
                throw new Error("FP2 service name missing from discovery.");
            }
            const { HttpClient } = require("hap-controller");
            client = new HttpClient(service.id, service.address, service.port);
            const pairingData = await client.startPairing(entry.pairMethod);
            await client.finishPairing(pairingData, pin);
            const pairing = client.getLongTermData();
            if (!pairing) {
                throw new Error("Pairing data missing");
            }
            res.json({
                pairing: {
                    ...pairing,
                    name: service.name,
                },
            });
        } catch (_error) {
            res.status(400).json({ error: "Pairing failed. Check the code and the FP2 state." });
        } finally {
            await client?.close().catch(() => {});
        }
    });
}

function register(RED) {
    registerAdminRoutes(RED);
    const dnssd = require(require.resolve("dnssd", { paths: [require.resolve("hap-controller")] }));

    async function resolveFP2(name) {
        const service = await dnssd.resolveService(`${name}._hap._tcp.local`, { timeout: RESOLVE_TIMEOUT_MS });
        const address = (service.addresses || []).find(item => require("node:net").isIPv4(item));
        if (!address) throw new Error(`FP2 ${name}: no IPv4 address.`);
        return { address, port: service.port };
    }

    function FP2Node(nodeConfig) {
        RED.nodes.createNode(this, nodeConfig);
        const node = this;
        const lastValues = new Map();
        let config;
        let client;
        let stopped = false;
        let canNotify = true;
        let reconnectTimer;
        let delay = 1000;
        let attempt = 0;
        const topic = nodeConfig.topic;

        function consume(data, initial = false) {
            for (const characteristic of data.characteristics || []) {
                if (String(characteristic.aid) !== config.aid) continue;
                if (characteristic.status !== undefined && Number(characteristic.status) !== 0) continue;
                if (characteristic.value === undefined) continue;
                const key = String(characteristic.iid);
                const entity = config.entities[key];
                if (!entity) continue;
                if (lastValues.get(key) === characteristic.value) continue;
                lastValues.set(key, characteristic.value);
                node.send({
                    topic,
                    type: entity.type,
                    payload: characteristic.value,
                    entity: entity.name,
                    index: entity.index,
                    iid: entity.iid,
                    timestamp: new Date().toISOString(),
                });
            }
        }

        async function retry(current, token, error) {
            if (stopped || token !== attempt || reconnectTimer) {
                return;
            }
            attempt += 1;
            node.status({ fill: "red", shape: "ring", text: "disconnected" });
            if (canNotify) {
                canNotify = false;
                node.error(error, { topic });
            } else {
                node.warn(error);
            }
            if (client === current) {
                client = undefined;
            }
            reconnectTimer = setTimeout(() => {
                reconnectTimer = undefined;
                void connect();
            }, delay);
            delay = Math.min(delay * 2, 60000);
            if (current) {
                current.removeAllListeners();
                await current.close().catch(() => {});
            }
        }

        async function connect() {
            const token = ++attempt;
            const isStale = () => stopped || token !== attempt;
            let current;
            node.status({ fill: "yellow", shape: "ring", text: "connecting" });
            const storedPairing = node.credentials?.pairing;
            if (!storedPairing) {
                node.status({ fill: "red", shape: "ring", text: "pairing required" });
                return;
            }
            let pairing;
            try {
                pairing = JSON.parse(storedPairing);
            } catch {
                pairing = null;
            }
            if (!PAIRING_FIELDS.every(field =>
                typeof pairing?.[field] === "string" && pairing[field].trim())) {
                node.status({ fill: "red", shape: "ring", text: "invalid pairing" });
                node.warn("Stored FP2 pairing data is invalid.");
                return;
            }
            try {
                const { address, port } = await resolveFP2(pairing.name);
                if (isStale()) return;
                node.log(`Connecting to FP2 ${address}:${port}`);
                const { HttpClient } = require("hap-controller");
                current = new HttpClient(pairing.AccessoryPairingID,
                    address,
                    port, pairing, {
                        usePersistentConnections: true,
                        subscriptionsUseSameConnection: true,
                    });
                client = current;
                const database = await current.getAccessories();
                if (isStale()) return;
                config = buildConfig(database);
                node.send({ topic, payload: config, type: "config", raw: database.accessories });
                const keys = Object.keys(config.entities).map(iid => `${config.aid}.${iid}`);
                if (!keys.length) throw new Error("No event-capable HAP entity found.");
                const values = await current.getCharacteristics(keys);
                if (isStale()) return;
                consume(values, true);
                current.on("event", event => {
                    if (!isStale()) consume(event);
                });
                current.on("event-disconnect", () => {
                    void retry(current, token, "FP2 event connection lost.");
                });
                const result = await current.subscribeCharacteristics(keys);
                if (isStale()) return;
                if (result?.characteristics?.some(characteristic => Number(characteristic.status || 0) !== 0)) {
                    throw new Error("The FP2 rejected an event subscription.");
                }
                delay = 1000;
                canNotify = true;
                node.status({ fill: "green", shape: "dot", text: `${keys.length} states` });
            } catch (error) {
                const message = error.code ? `FP2 error: ${error.code}` : error.message;
                await retry(current, token, message);
            }
        }

        node.on("close", (removed, done) => {
            stopped = true;
            attempt += 1;
            clearTimeout(reconnectTimer);
            const current = client;
            client = undefined;
            if (current) current.removeAllListeners();
            Promise.resolve().then(() => current?.close()).catch(() => {}).finally(done);
        });
        void connect();
    }

    RED.nodes.registerType("fp2", FP2Node, {
        credentials: {
            pairing: { type: "password" }
        }
    });
}

module.exports = register;
