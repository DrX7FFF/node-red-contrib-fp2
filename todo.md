Vérifier la lecture de la base
Regarder s'il y a une versoin de la base
conditionner certain message
Récupérer les erreurs

petit bug à la connection :
nodered  | 7 Oct 20:51:42 - [info] [fp2:365609b9c531873c] Connecting to FP2 192.168.1.141:60846
nodered  | 7 Oct 20:51:43 - [warn] [fp2:365609b9c531873c] Ambiguous global presence sensor; no global topic assigned.

ajouter une coche si on veut renvoyer ou pas l'état à la connexion


répartir les .gitignore par sous dossier/service


notter différence entre bouton reset pendant 10s (conserve le paramétrage) et 10x (reset usine)

Documenter :
- le changement du fichier compose.yaml
- modification pour le port 80

Bash pour autoriser au niveau du système :
echo "net.ipv4.ip_unprivileged_port_start=80" | sudo tee /etc/sysctl.d/99-ports.conf
sudo sysctl --system

## Vérifier dans la doc qu'on touche bien au settings.js sur les autres réglages
 Ensuite, `uiPort: 80` dans `settings.js`, ou `PORT=80` en variable d'environnement si ton `settings.js` lit `process.env.PORT`.

ajouter adminAuth dans settings.js



Peut être devoir installer :
sudo apt install libnss-resolve
resolvectl status end0
sudo resolvectl mdns end0 yes

resolvectl query YeelightColorBulb-AE27.local
ping YeelightColorBulb-AE27.local

sinon sudo apt install avahi-daemon libnss-mdns

## Vérification des ports après le démarrage te montre tout ce qui écoute
ss -tlnp
