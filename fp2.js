"use strict";

const PAIRING_CODE = /^\d{3}-\d{2}-\d{3}$/;
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
    const usedSlugs = new Set();
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
        warnings.push("Plusieurs capteurs portent un nom de presence globale.");
    } else if (occupancy.length > 0) {
        warnings.push("Capteur de presence global ambigu; aucun topic global n'a ete attribue.");
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
        if (!candidate.name || isGlobalName(candidate.name)) {
            unresolved.push({ aid: candidate.aid, iid: candidate.iid, kind: "zone", name: candidate.name || null });
            continue;
        }
        const baseSlug = slug(candidate.name);
        if (!baseSlug) {
            unresolved.push({ aid: candidate.aid, iid: candidate.iid, kind: "zone", name: candidate.name });
            continue;
        }
        let zone = baseSlug;
        if (usedSlugs.has(zone)) zone = `${zone}-${candidate.aid}-${candidate.iid}`;
        usedSlugs.add(zone);
        addEntity(candidate, "zone", `${prefix}/zone/${zone}`, { zone });
    }

    if (illuminance.length === 1) {
        addEntity(illuminance[0], "illuminance", `${prefix}/illuminance`);
    } else if (illuminance.length > 1) {
        const namedGlobalLight = illuminance.filter(candidate => isGlobalName(candidate.name));
        if (namedGlobalLight.length === 1) {
            addEntity(namedGlobalLight[0], "illuminance", `${prefix}/illuminance`);
        } else {
            warnings.push("Plusieurs capteurs de luminosite sont exposes; le topic principal reste ambigu.");
            for (const candidate of illuminance) {
                unresolved.push({ aid: candidate.aid, iid: candidate.iid, kind: "illuminance", name: candidate.name || null });
            }
        }
    }

    return { entities, warnings, unresolved };
}

function registerAdminRoutes(RED, dependencies = {}) {
    const discovered = new Map();
    const discoveryTimeout = dependencies.discoveryTimeout || 5000;
    const discoveryFactory = dependencies.createDiscovery || (() => {
        const { IPDiscovery } = require("hap-controller");
        return new IPDiscovery();
    });
    const clientFactory = dependencies.createClient || ((id, address, port, pairing) => {
        const { HttpClient } = require("hap-controller");
        return new HttpClient(id, address, port, pairing);
    });
    const permission = RED.auth?.needsPermission
        ? RED.auth.needsPermission("flows.write")
        : (req, res, next) => next();

    RED.httpAdmin.get("/fp2/pairing/discover", permission, (_req, res) => {
        const discovery = discoveryFactory();
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
                    const token = require("node:crypto").randomBytes(24).toString("hex");
                    const pairMethod = await discovery.getPairMethod(service);
                    discovered.set(token, {
                        service,
                        pairMethod,
                        expiresAt: Date.now() + 120000,
                    });
                    return {
                        token,
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
                res.status(500).json({ error: "Echec de la decouverte HAP." });
            }
        }, discoveryTimeout);
    });

    RED.httpAdmin.post("/fp2/pairing/pair", permission, async (req, res) => {
        const { token, pin } = req.body || {};
        const entry = discovered.get(token);
        if (!entry || entry.expiresAt < Date.now()) {
            discovered.delete(token);
            res.status(400).json({ error: "Relancez la decouverte avant l'appairage." });
            return;
        }
        if (!entry.service.availableToPair) {
            res.status(409).json({ error: "Cet accessoire n'est pas disponible pour un nouvel appairage." });
            return;
        }
        if (typeof pin !== "string" || !PAIRING_CODE.test(pin)) {
            res.status(400).json({ error: "Le code HomeKit doit respecter le format XXX-XX-XXX." });
            return;
        }

        let client;
        try {
            const service = entry.service;
            if (!service.host) {
                throw new Error("Nom d'hote FP2 absent de la decouverte.");
            }
            client = clientFactory(service.id, service.address, service.port);
            const pairingData = await client.startPairing(entry.pairMethod);
            await client.finishPairing(pairingData, pin);
            const pairing = client.getLongTermData();
            if (!pairing) {
                throw new Error("Pairing data missing");
            }
            res.json({
                pairing: {
                    ...pairing,
                    accessoryId: service.id,
                    host: service.host,
                    port: service.port,
                    name: service.name,
                },
            });
        } catch (_error) {
            res.status(400).json({ error: "Appairage impossible. Verifiez le code et l'etat du FP2." });
        } finally {
            discovered.delete(token);
            await client?.close().catch(() => {});
        }
    });
}

function register(RED, TestClient, testDependencies) {
    registerAdminRoutes(RED, testDependencies);
    const lookup = testDependencies?.lookup || require("node:dns").promises.lookup;
    function loadDnssd() {
        try {
            return require(require.resolve("dnssd", { paths: [require.resolve("hap-controller")] }));
        } catch (_error) {
            return require("dnssd");
        }
    }

    // Resolution mDNS directe du FP2 deja appaire (adresse et port courants),
    // sans parcourir le reseau : requetes SRV/TXT/A sur le nom memorise.
    async function resolveByName(pairing) {
        let dnssd;
        try {
            dnssd = testDependencies?.dnssd || loadDnssd();
        } catch (_error) {
            return undefined;
        }
        const net = require("node:net");
        if (pairing.name) {
            try {
                const service = await dnssd.resolveService(`${pairing.name}._hap._tcp.local`, { timeout: 3000 });
                const address = (service.addresses || []).find(item => net.isIPv4(item));
                if (address) return { address, port: service.port };
            } catch (_error) {
                // essai suivant
            }
        }
        const hostname = String(pairing.host || "").replace(/\.$/, "");
        if (hostname) {
            try {
                const { answer } = await dnssd.resolve(hostname, "A", { timeout: 3000 });
                if (answer?.address) return { address: answer.address };
            } catch (_error) {
                // repli sur la resolution systeme
            }
        }
        return undefined;
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
                if (entity.kind === "zone") message.zone = entity.name;
                node.send(message);
            }
        }

        async function retry(current, token, error) {
            if (stopped || token !== attempt || reconnectTimer) {
                return;
            }
            attempt += 1;
            node.status({ fill: "red", shape: "ring", text: "deconnecte" });
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
            node.status({ fill: "yellow", shape: "ring", text: "connexion" });
            const storedPairing = node.credentials?.pairing;
            if (!storedPairing) {
                node.status({ fill: "red", shape: "ring", text: "appairage requis" });
                return;
            }
            let pairing;
            try {
                pairing = JSON.parse(storedPairing);
                if (!pairing || typeof pairing !== "object" || Array.isArray(pairing)) {
                    throw new Error("Donnees d'appairage invalides.");
                }
            } catch (_error) {
                node.status({ fill: "red", shape: "ring", text: "credential invalide" });
                node.warn("Les donnees d'appairage FP2 memorisees sont invalides.");
                return;
            }
            try {
                const accessoryId = pairing.accessoryId || pairing.AccessoryPairingID;
                const manualHost = (config.host || "").trim();
                const found = manualHost ? undefined : await resolveByName(pairing);
                if (stopped || token !== attempt) return;
                const host = manualHost || found?.address || pairing.host || pairing.address;
                const address = require("node:net").isIP(host)
                    ? host
                    : (await lookup(host, { family: 4 })).address;
                if (stopped || token !== attempt) return;
                const HttpClient = TestClient || require("hap-controller").HttpClient;
                current = new HttpClient(accessoryId,
                    address,
                    Number(config.port || found?.port || pairing.port), pairing, {
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
                    throw new Error("Aucune entite HAP avec notifications trouvee.");
                }
                const keys = [...entities.keys()];
                const values = await current.getCharacteristics(keys);
                if (stopped || token !== attempt) return;
                consume(values, true);
                current.on("event", event => {
                    if (!stopped && token === attempt) consume(event);
                });
                current.on("event-disconnect", () => {
                    void retry(current, token, "Connexion aux evenements FP2 interrompue.");
                });
                const result = await current.subscribeCharacteristics(keys);
                if (stopped || token !== attempt) return;
                if (result?.characteristics?.some(characteristic => Number(characteristic.status || 0) !== 0)) {
                    throw new Error("Le FP2 a refuse un abonnement aux evenements.");
                }
                delay = 1000;
                node.status({ fill: "green", shape: "dot", text: `${entities.size} etats` });
            } catch (error) {
                const message = error.code ? `Erreur FP2 : ${error.code}` : error.message;
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
module.exports.buildEntities = buildEntities;
module.exports.registerAdminRoutes = registerAdminRoutes;