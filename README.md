# node-red-contrib-fp2

Node-RED input node that pairs directly with an Aqara FP2 over HomeKit IP and emits presence and illuminance changes into a flow. Python and MQTT are not runtime dependencies.

## Requirements and installation

- Node.js 18 or later and a running Node-RED installation.
- The Node-RED host must be able to reach the FP2 on the local network. mDNS discovery requires multicast discovery to pass between the host/container and the FP2.

Install from the package directory in the Node-RED user directory:

```sh
npm install /path/to/node-red-contrib-fp2
```

Restart Node-RED, add the **FP2** input node, open its settings, and choose **Rechercher le FP2**. Select an accessory marked available for pairing, enter its HomeKit setup code, and choose **Appairer et memoriser**. Deploy the flow to persist the generated pairing as a Node-RED credential and start the HAP connection.

The pairing code is sent only to the local Node-RED admin endpoint during setup and is not logged or stored. Long-term HomeKit credentials are stored in the node's password credential field, not in the exported flow. Protect the Node-RED editor with authentication and HTTPS when accessed over an untrusted network. Back up the Node-RED credential store together with the configured `credentialSecret`; without that secret, encrypted credentials cannot be recovered.

## Pairing availability

HomeKit Pair Setup is available only when discovery reports the accessory as available for pairing. If the FP2 is already paired, remove/revoke the old pairing or otherwise make the accessory available through its existing controller/Aqara setup first. Pair through discovery and the HomeKit setup code; importing external pairing data is not supported.

## Configuration and messages

The node supports an optional name, IP address and HAP port override, and topic prefix (default `fp2`). The discovery result supplies the device ID, address, and port for a new pairing.

Each change emits one message. Presence payloads are booleans (`true` means occupied); illuminance payloads are numeric. Initial values are read silently and repeated values are suppressed.

| Entity | Topic |
| --- | --- |
| Global presence, if unambiguous | `<prefix>/presence` |
| Named zone | `<prefix>/zone/<slug>` |
| Illuminance, if unambiguous | `<prefix>/illuminance` |

Messages include `msg.kind`, `msg.entity`, `msg.aid`, `msg.iid`, and an ISO-8601 `msg.timestamp`. Zone messages also include `msg.zone`. `msg.raw` contains the complete parsed event object emitted by `hap-controller`; when one event contains several characteristics, that same event object is attached to each corresponding output message. Ambiguous global presence or illuminance mappings are warned about rather than guessed. Only characteristics supporting HAP event notifications are subscribed.

## Docker

Install the package in the persistent Node-RED user directory (commonly `/data`), and preserve Node-RED's credential file and `credentialSecret` across container recreation. The Node-RED process must have network access to the FP2; host networking or working mDNS forwarding may be required for discovery. If multicast discovery is unavailable, use the address and port override after pairing the accessory on a network where discovery works.

## Development tests

The tests use fake HAP discovery and clients; they do not pair with or contact a physical FP2.

```sh
npm install --ignore-scripts
npm test
```

The implementation uses the IP transport from `hap-controller`. That dependency includes optional BLE-related packages; installation scripts are disabled for the offline development test command because Bluetooth is not used by this node.

Real-device pairing, notification delivery, zone changes, illuminance, and reconnect behavior still need validation with an FP2.
Connect your Node Red to your FP2
