répartir les .gitignore par sous dossier/service


Documenter :
- le changement du fichier compose.yaml

ajouter adminAuth dans settings.js

mettre IP Statique pour FP2


Peut être devoir installer :
sudo apt install libnss-resolve
resolvectl status end0
sudo resolvectl mdns end0 yes

resolvectl query YeelightColorBulb-AE27.local
ping YeelightColorBulb-AE27.local

sinon sudo apt install avahi-daemon libnss-mdns

## Vérification des ports après le démarrage te montre tout ce qui écoute
ss -tlnp
