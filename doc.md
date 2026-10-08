Updated todo list

Je vais recenser les données effectivement accessibles à chaque étape dans le nœud, en séparant ce qui vient du pairing, de la connexion HAP et des notifications. Je vérifierai aussi si la bibliothèque expose d’autres événements ou seulement ceux que le code écoute actuellement.

Read , lines 1 to 215

Read , lines 215 to 368

Read 

Read 

J’ai confirmé le flux concret : après le pairing, le code relit la base HAP puis les valeurs initiales, et ne publie que les changements des caractéristiques sélectionnées. Je distingue maintenant les données effectivement lues de celles que le nœud choisit actuellement de filtrer ou de ne pas transmettre, pour éviter de présenter les possibilités générales de HomeKit comme garanties pour le FP2.

Searched for files matching `**/*test*`, no matches

Searched for regex `getAccessories|getCharacteristics|subscribeCharacteristics|\.on\(`, 8 results

Read 

Oui. Pour décider tes propres règles, il faut distinguer **ce que le nœud récupère**, **ce qu’il garde**, et **ce qu’il publie**. Voici l’inventaire de ce que le code actuel fait.

**1. Découverte, avant le pairing**

La recherche HomeKit obtient des informations DNS-SD sur les accessoires trouvés. L’interface n’en affiche qu’une partie : `name`, `id`, `model`, `address`, `port` et `availableToPair`. Le code garde aussi temporairement l’objet de service et la méthode de pairing à utiliser. Voir `fp2.js:114`.

**2. Pairing**

Le code utilise le code HomeKit pour effectuer le pairing, puis récupère les données d’identification à long terme. Il les stocke comme credential Node-RED, avec notamment le nom DNS-SD, l’identifiant HomeKit de l’accessoire et les clés de l’accessoire et du contrôleur. Le code n’obtient pas encore les zones ni leurs valeurs à cette étape. Voir `fp2.js:151`.

**3. Connexion**

À chaque démarrage ou reconnexion, le nœud résout le nom DNS-SD pour obtenir l’adresse IPv4 et le port, puis se connecte à l’accessoire. Ces informations servent à la connexion ; elles ne sont pas émises comme messages Node-RED. Voir `fp2.js:203`.

**4. Lecture de la base HomeKit**

Une fois connecté, `getAccessories()` récupère la base d’accessoires HAP. Elle contient la structure que le FP2 expose : accessoires, services et caractéristiques. Le code examine notamment les identifiants `aid` et `iid`, les types, les permissions d’événement (`perms`) et les noms de services ou caractéristiques.

Le nœud publie les accessoires dans un message `kind: "base"`. Voir `fp2.js:318`.

**5. Lecture initiale et notifications**

Le nœud lit ensuite les valeurs initiales des caractéristiques sélectionnées. Elles servent à établir l’état de départ, mais ne produisent pas de message. Il s’abonne ensuite aux changements de ces caractéristiques seulement.

Pour une notification, `raw` est l’objet d’événement reçu de `hap-controller`. Le code cherche dedans les caractéristiques avec `aid`, `iid`, éventuellement `status`, et `value`. Si l’identifiant correspond à une caractéristique suivie et que sa valeur est reconnue, il émet un message. Les présences deviennent des booléens, l’éclairement un nombre. Les valeurs répétées sont ignorées. Voir `fp2.js:226`.

**6. Messages réellement envoyés**

Un message de changement contient `topic`, `payload`, `raw`, `kind`, `entity`, `aid`, `iid` et `timestamp`. Les entités de type zone ont aussi `zone`. Si un événement contient plusieurs caractéristiques, le même objet `raw` complet est attaché à chaque message correspondant. En revanche, un événement ne contenant que des caractéristiques que le nœud ne suit pas ne produit aucun message. Voir `fp2.js:247`.

Enfin, le code n’émet pas de messages Node-RED pour le pairing, la connexion ou les erreurs : il met à jour le statut du nœud et peut journaliser un avertissement. Il écoute les notifications (`event`) et la déconnexion des notifications (`event-disconnect`), pas un événement générique « connecté ». Voir `fp2.js:330`.

Donc, l’inventaire **exact** des champs et valeurs spécifiques à ton FP2 n’est pas déductible du code seul : il faut inspecter la base HAP et les notifications réelles de l’appareil. Aujourd’hui, le nœud filtre ces données avant de les rendre visibles ; exposer temporairement la base complète à la connexion et chaque événement brut avant filtrage permettrait de définir tes règles à partir de données observées.

Created 3 todos