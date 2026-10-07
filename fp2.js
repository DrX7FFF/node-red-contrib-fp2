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
const GLOBAL_NAMES = new Set([
    "global occupancy",
    "global presence",
    "occupancy",
    "occupancy sensor",
    "presence",
    "presence globale",
    "presence global",
    "presence sensor",
]);

function shortType(value) {
    return String(value || "").toUpperCase().split("-")[0].replace(/^0+/, "");
}

function slug(name) {
    return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isGlobalName(name) {
    return GLOBAL_NAMES.has(slug(name).replace(/-/g, " "));
}

function serviceName(service) {
    const characteristics = service.characteristics || [];
    const named = ["E3", "23"].map(type => characteristics.find(characteristic =>
        shortType(characteristic.type) === type && typeof characteristic.value === "string"
        && characteristic.value.trim())).find(Boolean);
    if (named) return named.value.trim();
    return typeof service.name === "string" ? service.name.trim() : "";
}

function buildEntities(database, prefix = "fp2") {
    const entities = new Map();
    const occupancy = [];
    const illuminance = [];
    const warnings = [];
    const unresolved = [];
    for (const accessory of database.accessories || []) {
        for (const service of accessory.services || []) {
            const characteristics = service.characteristics || [];
            const name = serviceName(service);
            for (const characteristic of characteristics) {
                const type = shortType(characteristic.type);
                if (type !== "71" && type !== "6B") continue;
                const candidate = {
                    aid: String(accessory.aid),
                    iid: String(characteristic.iid),
                    name,
                    eventCapable: characteristic.perms?.includes("ev"),
                };
                if (type === "71") {
                    occupancy.push(candidate);
                } else {
                    illuminance.push(candidate);
                }
            }
        }
    }

    const namedGlobal = occupancy.filter(candidate => isGlobalName(candidate.name));
    let globalSensor;
    if (occupancy.length === 1) {
        globalSensor = occupancy[0];
    } else if (namedGlobal.length === 1) {
        globalSensor = namedGlobal[0];
    } else if (namedGlobal.length > 1) {
        warnings.push("Several sensors have a global presence name.");
    } else if (occupancy.length > 0) {
        warnings.push("Ambiguous global presence sensor; no global topic assigned.");
    }

    function addEntity(candidate, kind, topic, extra = {}) {
        const key = `${candidate.aid}.${candidate.iid}`;
        if (!candidate.eventCapable) {
            unresolved.push({ aid: candidate.aid, iid: candidate.iid, kind, reason: "no-events" });
            return;
        }
        entities.set(key, { ...candidate, kind, topic, ...extra });
    }

    if (globalSensor) {
        addEntity(globalSensor, "presence", `${prefix}/presence`);
    }
    for (const candidate of occupancy) {
        if (globalSensor && candidate === globalSensor) continue;
        const zoneId = `${candidate.aid}-${candidate.iid}`;
        addEntity(candidate, "zone", `${prefix}/zone/${zoneId}`, { zone: candidate.name || zoneId });
    }

    if (illuminance.length === 1) {
        addEntity(illuminance[0], "illuminance", `${prefix}/illuminance`);
    } else if (illuminance.length > 1) {
        const namedGlobalLight = illuminance.filter(candidate => isGlobalName(candidate.name));
        if (namedGlobalLight.length === 1) {
            addEntity(namedGlobalLight[0], "illuminance", `${prefix}/illuminance`);
        } else {
            warnings.push("Several illuminance sensors exposed; main topic is ambiguous.");
            for (const candidate of illuminance) {
                unresolved.push({ aid: candidate.aid, iid: candidate.iid, kind: "illuminance", name: candidate.name || null });
            }
        }
    }

    return { entities, warnings, unresolved };
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

    function FP2Node(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const lastValues = new Map();
        let entities = new Map();
        let client;
        let stopped = false;
        let reconnectTimer;
        let delay = 1000;
        let attempt = 0;
        const prefix = (config.topicPrefix || "fp2").replace(/^\/+|\/+$/g, "") || "fp2";

        function consume(data, initial = false) {
            for (const characteristic of data.characteristics || []) {
                const key = `${characteristic.aid}.${characteristic.iid}`;
                const entity = entities.get(key);
                if (!entity || (characteristic.status !== undefined && Number(characteristic.status) !== 0)) {
                    continue;
                }
                const value = entity.kind === "illuminance"
                    ? Number(characteristic.value)
                    : [0, 1, false, true].includes(characteristic.value)
                        ? Boolean(characteristic.value)
                        : undefined;
                if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) continue;
                const previous = lastValues.get(key);
                lastValues.set(key, value);
                if (initial || previous === value) {
                    continue;
                }
                const message = {
                    topic: entity.topic,
                    payload: value,
                    raw: data,
                    kind: entity.kind,
                    entity: entity.name,
                    aid: entity.aid,
                    iid: entity.iid,
                    timestamp: new Date().toISOString(),
                };
                if (entity.kind === "zone") message.zone = entity.name || entity.zone;
                node.send(message);
            }
        }

        async function retry(current, token, error) {
            if (stopped || token !== attempt || reconnectTimer) {
                return;
            }
            attempt += 1;
            node.status({ fill: "red", shape: "ring", text: "disconnected" });
            node.warn(error);
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
                if (stopped || token !== attempt) return;
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
                if (stopped || token !== attempt) return;
                const mapping = buildEntities(database, prefix);
                entities = mapping.entities;
                for (const warning of mapping.warnings) node.warn(warning);
                if (!entities.size) {
                    throw new Error("No event-capable HAP entity found.");
                }
                const keys = [...entities.keys()];
                const values = await current.getCharacteristics(keys);
                if (stopped || token !== attempt) return;
                consume(values, true);
                current.on("event", event => {
                    if (!stopped && token === attempt) consume(event);
                });
                current.on("event-disconnect", () => {
                    void retry(current, token, "FP2 event connection lost.");
                });
                const result = await current.subscribeCharacteristics(keys);
                if (stopped || token !== attempt) return;
                if (result?.characteristics?.some(characteristic => Number(characteristic.status || 0) !== 0)) {
                    throw new Error("The FP2 rejected an event subscription.");
                }
                delay = 1000;
                node.status({ fill: "green", shape: "dot", text: `${entities.size} states` });
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