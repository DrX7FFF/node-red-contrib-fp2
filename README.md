# node-red-contrib-fp2

Node-RED input node that pairs directly with an Aqara FP2 over HomeKit IP and emits presence and illuminance changes into a flow.

## Requirements and installation

- Node.js 18 or later and a running Node-RED installation.
- The Node-RED host must be able to reach the FP2 on the local network. mDNS discovery requires multicast discovery to pass between the host/container and the FP2.

Install from the package directory in the Node-RED user directory:

```sh
npm install /path/to/node-red-contrib-fp2
```

Restart Node-RED, add the **FP2** input node, open its settings, and choose **Search for FP2**. Select an accessory marked available for pairing, enter its HomeKit setup code, and choose **Pair and save**. Deploy the flow to persist the generated pairing as a Node-RED credential and start the HAP connection.

The pairing code is sent only to the local Node-RED admin endpoint during setup and is not logged or stored. Long-term HomeKit credentials are stored in the node's password credential field, not in the exported flow. Protect the Node-RED editor with authentication and HTTPS when accessed over an untrusted network. Back up the Node-RED credential store together with the configured `credentialSecret`; without that secret, encrypted credentials cannot be recovered.

## Pairing availability

HomeKit Pair Setup is available only when discovery reports the accessory as available for pairing. If the FP2 is already paired, remove/revoke the old pairing or otherwise make the accessory available through its existing controller/Aqara setup first. Pair through discovery and the HomeKit setup code; importing external pairing data is not supported.

## Configuration and messages

The node has two settings: a name (editor label) and a topic prefix (default `fp2`). There is no host or port setting.

Pairing stores, in the encrypted `pairing` credential, the HomeKit long-term data (`AccessoryPairingID`, `AccessoryLTPK`, controller ID and keys) and the FP2's DNS-SD service name (for example `Presence-Sensor-FP2-D61A`). No IP address or port is stored.

Before every connection and reconnection, the node resolves the service `<name>._hap._tcp.local` with DNS-SD (SRV/TXT/A) to get the current IPv4 address and HAP port. The FP2 answers these targeted queries at any time, whereas it answers service browsing only shortly after it boots, so no browsing is performed after pairing. The resolution timeout is `RESOLVE_TIMEOUT_MS` (20 s) at the top of `fp2.js`.

If the resolution fails, the node shows the disconnected status, logs a warning, and retries after 1, 2, 4, 8, 16, 32, then 60 seconds. Successful connection resets the retry delay. Connection errors do not produce output messages.

Each change emits one message. Presence payloads are booleans (`true` means occupied); illuminance payloads are numeric. Initial values are read silently and repeated values are suppressed.

| Entity | Topic |
| --- | --- |
| Global presence, if unambiguous | `<prefix>/presence` |
| Zone | `<prefix>/zone/<aid>-<iid>` |
| Illuminance, if unambiguous | `<prefix>/illuminance` |

Messages include `msg.kind`, `msg.entity`, `msg.aid`, `msg.iid`, and an ISO-8601 `msg.timestamp`. Zone topics use the HAP AID/IID, independently of the zone name; zone messages also include `msg.zone` with the name when available. `msg.raw` contains the complete parsed event object emitted by `hap-controller`; when one event contains several characteristics, that same event object is attached to each corresponding output message. Ambiguous global presence or illuminance mappings are warned about rather than guessed. Only characteristics supporting HAP event notifications are subscribed.

## Docker

Install the package in the persistent Node-RED user directory (commonly `/data`), and preserve Node-RED's credential file and `credentialSecret` across container recreation. The container must receive mDNS multicast traffic (host networking is the simplest option).

To check service resolution from inside the container:

```sh
docker exec -w /data nodered node -e "require('dnssd').resolveService('Presence-Sensor-FP2-D61A._hap._tcp.local',{timeout:20000}).then(s=>console.log(s.addresses,s.port)).catch(e=>console.log('ERR',e.message))"
```

## Development tests

The tests replace `hap-controller` and `dnssd` at module load time; they do not pair with or contact a physical FP2.

```sh
npm install --ignore-scripts
npm test
```

The implementation uses the IP transport from `hap-controller`. That dependency includes optional BLE-related packages; installation scripts are disabled for the offline development test command because Bluetooth is not used by this node.

Real-device pairing, notification delivery, zone changes, illuminance, and reconnect behavior still need validation with an FP2.
Connect your Node Red to your FP2


**1. Découverte HomeKit**
Il faut rebooter le FP2 sinon il ne répond pas à la découverte de service
```bash
avahi-browse -rt _hap._tcp
```
`sf=1` indique un accessoire non appairé, et `sf=0` un accessoire appairé.


**2. Résolution ciblée du nom d’hôte**
Après appairage, en remplaçant le nom par celui obtenu :
```bash
avahi-resolve-host-name -4 NOM-HOTE.local
```