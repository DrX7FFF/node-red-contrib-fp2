Oui, `sf=0` signifie que le FP2 est appairé. Le problème de sauvegarde vient bien d'un bug dans `fp2.html`.

Node-RED enregistre un credential en cherchant un champ dont l'id est `node-input-` suivi du nom du credential. Ton credential s'appelle `pairing`, donc l'id attendu est `node-input-pairing`, alors que ton code utilise `node-input-credentials-pairing`. Résultat : le champ n'est jamais lu, rien n'est stocké, et le nœud affiche "appairage requis".

Dans `fp2.html`, trois endroits à changer :

```js
$("#node-input-pairing")
    .val(JSON.stringify(response.pairing))
    .trigger("change");
```

```html
<label for="node-input-pairing">Pairing existant</label>
<input type="password" id="node-input-pairing" autocomplete="new-password" placeholder="Coller l'objet aiohomekit JSON (optionnel)">
```

Il faut ensuite redémarrer Node-RED (`docker restart nodered`) et recharger la page du navigateur (Ctrl+F5).

Le pairing généré lors de ton essai est perdu, car il n'a jamais été enregistré. Le FP2 est maintenant appairé à une clé que plus personne ne possède. Pour recommencer, il faut le réinitialiser (appui long sur son bouton reset), puis relancer l'appairage depuis l'IHM. Pense à cliquer sur Déployer juste après, sinon le credential n'est pas stocké.


## Config NodeRed :
Il reste 3 choses à faire pour Node-RED : 
uiPort: 80 (ou 1880) dans settings.js, 
avec le sysctl si tu gardes le 80, 
et localhost à la place de mosquitto et deconz dans tes nœuds de config.


1. **Port 80.** Node-RED tourne en utilisateur non-root, et en mode host le container ne peut pas ajuster ce réglage lui-même. Il faut abaisser le seuil sur l'hôte :
   ```
   echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/99-ports.conf
   sudo sysctl --system
   ```
   Ce réglage s'applique à tous les utilisateurs de `habserver`, ce qui est acceptable sur un serveur domotique perso. Ensuite, `uiPort: 80` dans `settings.js`, ou `PORT=80` en variable d'environnement si ton `settings.js` lit `process.env.PORT`.

2. **WebSocket deCONZ (4443).** Aujourd'hui Node-RED l'atteint via `deconz:4443` sur `domos_net`, mais tu ne le publies pas dans le compose. En mode host, `localhost:4443` ne répondra pas, donc ajoute `4443:4443` aux `ports:` de `deconz`. Pour l'API, `localhost:8080` marche déjà.

3. **Noms de containers.** `mosquitto` devient `localhost:1883`, `deconz` devient `localhost:8080` (et 4443 pour le WebSocket), comme tu l'as prévu.



## Vérification des ports 
(ss -tlnp après le démarrage te montre tout ce qui écoute).
