Documenter :
- le changement du fichier compose.yaml
- modification pour le port 80

Bash pour autoriser au niveau du système :
echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/99-ports.conf
sudo sysctl --system

## Vérifier dans la doc qu'on touche bien au settings.js sur les autres réglages
 Ensuite, `uiPort: 80` dans `settings.js`, ou `PORT=80` en variable d'environnement si ton `settings.js` lit `process.env.PORT`.

Peut être devoir installer :
sudo apt install libnss-resolve
resolvectl status end0
sudo resolvectl mdns end0 yes

resolvectl query YeelightColorBulb-AE27.local
ping YeelightColorBulb-AE27.local

sinon sudo apt install avahi-daemon libnss-mdns

## Vérification des ports 
(ss -tlnp après le démarrage te montre tout ce qui écoute).
