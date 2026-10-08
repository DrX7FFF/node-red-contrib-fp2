# node-red-contrib-fp2

Node-RED input node that pairs directly with an Aqara FP2 over HomeKit IP and emits presence and illuminance changes into a flow.

## Requirements and installation

- Node.js 18 or later and a running Node-RED installation.
- The Node-RED host must be able to reach the FP2 on the local network. mDNS discovery requires multicast discovery to discover the FP2 and resolved IP from FP2 Name.

Install from the package directory in the Node-RED user directory:

```sh
npm install /path/to/node-red-contrib-fp2
```

Restart Node-RED, add the **FP2** input node, open its settings, and choose **Search for FP2**. Select an accessory marked available for pairing, enter its HomeKit setup code, and choose **Pair and save**. Deploy the flow to persist the generated pairing as a Node-RED credential and start the HAP connection.

## Pairing availability

HomeKit Pair Setup is available only when discovery reports the accessory as available for pairing. If the FP2 is already paired, remove/revoke the old pairing or otherwise make the accessory available through its existing controller/Aqara setup first. Pair through discovery and the HomeKit setup code; importing external pairing data is not supported.

## For resetting the FP2 :
hold reset button during 10 s : FP2 will keep the zone configuration
press 10 times reset button : factory reset

## Configuration and messages

The node has two settings: a name (editor label) and a topic prefix (default `fp2`).

Pairing stores, in the encrypted `pairing` credential, the HomeKit long-term data and the FP2's DNS-SD service name.

If the resolution fails, the node shows the disconnected status, logs a warning, and retries after 1, 2, 4, 8, 16, 32, then 60 seconds. Successful connection resets the retry delay. Connection errors do not produce output messages.

Each change emits one message. Presence payloads are booleans (`true` means occupied); illuminance payloads are numeric. Initial values are read silently and repeated values are suppressed.

| Entity | Topic |
| --- | --- |
| Global presence, if unambiguous | `<prefix>/presence` |
| Zone | `<prefix>/zone/<aid>-<iid>` |
| Illuminance, if unambiguous | `<prefix>/illuminance` |

Messages include `msg.type`, `msg.entity`, `msg.aid`, `msg.iid`, and an ISO-8601 `msg.timestamp`. Zone topics use the HAP AID/IID, independently of the zone name; zone messages also include `msg.zone` with the name when available. `msg.raw` contains the complete parsed event object emitted by `hap-controller`; when one event contains several characteristics, that same event object is attached to each corresponding output message. Ambiguous global presence or illuminance mappings are warned about rather than guessed. Only characteristics supporting HAP event notifications are subscribed.

## Docker
mDNS doit remonter jusqu'au docker. Le plus simple est de mettre le réseau en mode host.

## Diagnostic
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
