# Gestion de flotte : installer la vraie appli

L'appli s'installe sur le téléphone (Android ou iPhone) et sur le PC, avec sa propre icône, en plein écran.
Les données sont synchronisées entre tous les appareils grâce à Supabase (gratuit).

## 1. Créer la base de données (Supabase, environ 5 minutes)

1. Créez un compte sur https://supabase.com, puis **New project**. Choisissez une région en Europe (Paris ou Frankfurt) et notez le mot de passe de la base.
2. Dans le projet, ouvrez **SQL Editor > New query**, collez tout le contenu de `supabase.sql`, puis cliquez sur **Run**. Le message attendu est « Success. No rows returned ».
3. Ouvrez **Authentication > Users > Add user > Create new user**. Saisissez votre e-mail et un mot de passe, et cochez **Auto Confirm User**. Faites de même pour chaque collègue qui doit utiliser l'appli.
4. Ouvrez **Authentication > Sign In / Providers** et désactivez **Allow new users to sign up**. Comme ça, personne d'autre ne peut se créer un compte.
5. Ouvrez **Project Settings > API** et copiez :
   - le **Project URL** (`https://xxxx.supabase.co`) ;
   - la clé publique **anon** (aussi appelée **publishable**). N'utilisez jamais la clé `service_role` ni la clé `secret`.

Collez ces deux valeurs dans `config.js`, ou envoyez-les à Claude dans le fil.

## 2. Mettre l'appli en ligne (GitHub Pages, gratuit)

1. Sur GitHub, créez un dépôt **public** vide nommé `gestion-flotte`.
2. Envoyez-y tous les fichiers de ce dossier. Pour le faire à la main : **Add file > Upload files**, puis glissez le contenu du zip `flotte-app.zip`.
3. Dans le dépôt, ouvrez **Settings > Pages**. Pour **Source**, choisissez **Deploy from a branch**, puis **main** et **/ (root)**, et cliquez sur **Save**.
4. Au bout d'une minute, l'appli est disponible sur `https://<votre-identifiant>.github.io/gestion-flotte/`.

## 3. Installer l'appli

- **Android (Chrome)** : ouvrez l'adresse de l'appli, puis appuyez sur le bouton « Installer l'appli » dans l'appli, ou sur le menu ⋮ puis « Installer l'application ».
- **iPhone (Safari)** : ouvrez l'adresse de l'appli, puis appuyez sur Partager et choisissez « Sur l'écran d'accueil ».
- **PC Windows (Edge ou Chrome)** : cliquez sur l'icône d'installation à droite de la barre d'adresse.

Connectez-vous ensuite avec l'e-mail et le mot de passe créés à l'étape 1.3.

## 4. Récupérer la flotte déjà saisie

Dans l'ancienne page, cliquez sur **Exporter Excel**, puis importez ce fichier dans la nouvelle appli avec le bouton **Importer**.
Les véhicules et les dates de CT sont repris. Les documents sont à rajouter, et l'historique repart de zéro.

## Rôles et droits

| Action | Admin | Utilisateur |
|---|---|---|
| Voir la flotte, l'historique et les documents | Oui | Oui |
| Sortir et rendre un véhicule | Oui | Oui |
| Ajouter, modifier ou supprimer un véhicule | Oui | Non |
| Gérer la maintenance | Oui | Non |
| Mettre à jour les dates de CT | Oui | Oui (en envoyant le PV) |
| Envoyer des documents (PV de CT, photos…) | Oui | Oui |
| Supprimer un document | Oui | Seulement les siens |
| Importer et exporter vers Excel | Oui | Non |
| Changer le rôle des utilisateurs | Oui | Non |

Les droits sont vérifiés par la base de données elle-même, pas seulement par l'affichage.
Chaque compte créé dans **Authentication > Users** reçoit le rôle Utilisateur. Un admin le passe en Admin depuis l'onglet **Utilisateurs** de l'appli.
Le premier compte créé dans le projet devient automatiquement Admin.

## Bon à savoir

- Si `config.js` reste vide, l'appli fonctionne quand même, mais les données restent sur l'appareil.
- L'appli s'ouvre aussi sans réseau. Les modifications, elles, ont besoin d'une connexion.
- Le forfait gratuit de Supabase offre 500 Mo de base et 1 Go pour les documents. Un projet gratuit est mis en pause après une semaine sans aucune connexion : il suffit de le relancer depuis le tableau de bord Supabase.
