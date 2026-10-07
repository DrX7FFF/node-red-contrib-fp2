## Correction module Bug

## Supprimer la sauvegarde de l'IP (afficher l'information seulement)
Par contre à chaque connection, refaire une découverte pas mDNS.
Sauvegarder le nom pour le sélectionner après la découverte
Peut être devoir installer :
sudo apt install libnss-resolve
resolvectl status end0
sudo resolvectl mdns end0 yes

resolvectl query YeelightColorBulb-AE27.local
ping YeelightColorBulb-AE27.local

sinon sudo apt install avahi-daemon libnss-mdns


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
