---
id: 3d0c
title: Tout ce que markdown sait faire ici
---

Tout ce qui suit a été fait avec la barre en haut de cette note. Aucun réglage, aucune extension. Sélectionne du texte et la barre agit dessus. Clique dans une ligne vide et elle commence quelque chose de neuf.

## Les mots

Tu peux mettre un mot en **gras**, en *italique*, ou ***les deux***. Tu peux le barrer, ~~comme celui-ci~~. Tu peux le <u>souligner</u>. Les petits caractères vont en <sub>indice</sub> et les puissances en <sup>exposant</sup>.

Le texte peut être <span style="color: #e03131">rouge</span>, <span style="color: #1971c2">bleu</span>, <span style="color: #2f9e44">vert</span> ou de l'une des neuf couleurs.

Il peut être ==surligné en jaune== ou <mark style="background-color: rgba(64, 192, 87, 0.35)">en vert</mark>.

Un spoiler cache des mots jusqu'à ce qu'on clique dessus : le cadeau est ||un tourne-disque||. Sélectionne les mots et choisis **Spoiler** dans le menu **Insérer**, ou tape deux barres de chaque côté.

Une icône ou un logo peut se glisser dans une ligne de texte, comme :icon[gift] :icon[coffee] :icon[rocket-launch] ou :logo[github]. Choisis-en un dans **Insérer** > **Icônes et logos**.

Le bouton **Aa** change la taille et la police. Le texte peut être <span style="font-size: 0.85em">petit</span>, normal ou <span style="font-size: 1.6em">grand</span>. Il peut être <span style="font-family: ui-sans-serif, system-ui, sans-serif">simple</span>, <span style="font-family: ui-serif, Georgia, Cambria, serif">avec empattements</span> ou <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">à chasse fixe</span>.

## Où se placent les mots

<p style="text-align: center;">Ce paragraphe est centré.</p>

<p style="text-align: right;">Celui-ci est poussé à droite.</p>

L'alignement déplace un paragraphe entier, jamais un mot seul. Mets le curseur dans le paragraphe et utilise le bouton d'alignement.

## Listes

- Une puce simple
- Une autre
  - Appuie sur Tab pour décaler une ligne
    - Et encore une fois

1. Une étape numérotée
2. Une deuxième étape
3. Insère une étape n'importe où et les numéros se corrigent tout seuls

- [x] Une case que tu as cochée

- [ ] Case

  - [ ] Appuie sur Tab pour décaler une tâche

  - [ ] Coche la case et regarde l'animation

- [ ] Appuie sur Maj et Tab pour réduire le décalage

## Tableaux

| Région | Notes | Part |
| --- | :---: | ---: |
| Europe | 1 204 | 48 % |
| Amériques | 902 | 36 % |
| Asie | 401 | 16 % |
<!-- table-fill: r0=blue r1c2=green r3c2=red -->

La colonne du milieu est centrée et la dernière alignée à droite. Fais glisser le bord d'une colonne pour l'élargir. Une cellule ou une ligne entière peut prendre une couleur depuis la barre du tableau. La petite flèche dans une cellule d'en-tête trie les lignes en dessous, et un deuxième clic les trie dans l'autre sens.

Un tableau sait aussi calculer. Tape `=` dans une cellule pour choisir une fonction. La cellule affiche le résultat et la note garde la formule : clique sur un résultat pour voir comment il a été obtenu.

| Article | Qté | Prix | Total |
| --- | ---: | ---: | ---: |
| Café | 2 | 3.50 | =B2*C2 |
| Gâteau | 1 | 4.20 | =B3*C3 |
|  |  | Somme | =SUM(D2:D3) |

## Encadrés

Un encadré est une boîte colorée pour ce qu'il ne faut surtout pas rater. Tape `[!` sur une ligne vide pour en choisir un.

> [!tip]+ Astuce
> Clique sur son icône pour le replier.

> [!warning]+ Avertissement
> Chaque type a sa couleur et son icône.

> [!danger]+ Danger
> Il y en a beaucoup. Le menu **Insérer** les liste.

> [!fold]- Repliable
> Ni cadre ni couleur : juste du texte qui reste discret jusqu'à ce que tu l'ouvres.

## Citations

> Une citation se décale de la marge et prend un trait coloré sur le côté.

## Notes de bas de page

Une note de bas de page garde une source ou une remarque hors du texte.[^1] Tape `[^1]` après un mot, ou choisis **Note de bas de page** dans le menu **Insérer**. Clique sur le petit numéro pour aller à la note.

## Code

Le code garde ses espaces et se colore selon le langage. Le nom en haut d’un bloc est son langage : clique dessus pour en choisir un autre.

```js
export function seal(note, key) {
  const nonce = randomBytes(24);
  return xchacha20poly1305(key, nonce).encrypt(note);
}
```

```python
def rolling_mean(values, window):
    return [sum(values[i:i + window]) / window
            for i in range(len(values) - window + 1)]
```

Un long bloc s’ouvre replié, pour que la suite de la note reste proche. Le bouton en dessous affiche toutes les lignes.

```js
const WORDS_PER_MINUTE = 200;

export function readingStats(markdown) {
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_~`>|-]/g, ' ');

  const words = text.split(/\s+/).filter(Boolean);
  const headings = markdown.match(/^#{1,6} /gm) ?? [];
  const tasks = markdown.match(/^\s*- \[[ x]\] /gm) ?? [];
  const done = tasks.filter((task) => task.includes('[x]'));

  return {
    words: words.length,
    minutes: Math.max(1, Math.round(words.length / WORDS_PER_MINUTE)),
    headings: headings.length,
    tasks: tasks.length,
    done: done.length,
  };
}

export function summary(stats) {
  const parts = [`${stats.words} words`, `${stats.minutes} min read`];
  if (stats.headings > 0) {
    parts.push(`${stats.headings} sections`);
  }
  if (stats.tasks > 0) {
    parts.push(`${stats.done} of ${stats.tasks} tasks done`);
  }
  return parts.join(' · ');
}

export function isLongRead(stats) {
  return stats.minutes >= 10;
}
```

Un bloc de code peut porter un titre. Clique sur le nom du langage et choisis **Ajouter un titre**. La flèche à côté du titre replie le bloc sur une seule ligne, et la note s'en souvient.

```bash title="backup.sh" fold
#!/bin/sh
# Copie le dossier des notes dans une archive datée.
tar -czf "notes-$(date +%F).tar.gz" "$HOME/Notes"
```

Un **Bloc à copier** contient une seule chose à copier, comme une adresse ou une commande. Son bouton copie tout en un clic.

```copy
ssh-keygen -t ed25519 -C "laptop"
```

Un bout de code court au milieu d'une phrase ressemble plutôt à `ceci`. Maintiens Cmd (Ctrl sous Windows et Linux) et clique dessus pour le copier.

## Maths

Les maths peuvent tenir dans une phrase, comme $a^2 + b^2 = c^2$, ou occuper leur propre ligne :

$$i\hbar\frac{\partial}{\partial t}\Psi = \hat{H}\Psi$$

## Images

![Le mont Fuji derrière des fleurs de cerisier.](/onboarding/fuji.webp){width=50 align=center}

Fais glisser une image dans une note, ou colle-la. Clique dessus une fois pour changer sa taille, ou pour la placer à gauche, au centre ou à droite. Celle du dessus est à mi-largeur et centrée.

## Cartes

```map
35.3606, 138.7274
Mont Fuji
```

Place un lieu dans une note avec **Insérer** > **Lieu**. La carte vient de notre propre serveur, donc aucune entreprise de cartographie ne voit où tu regardes. Dans toute autre app Markdown, elle se lit comme les coordonnées et le nom.

## Liens

Il y en a deux sortes, et elles ne se ressemblent pas, exprès.

- Un lien web ouvre un site : [privacynotes.app](https://privacynotes.app/fr)
- Un lien web peut porter un texte au survol. Pointe [celui-ci](https://privacynotes.app/fr/help "Nos pages d'aide") et attends.
- Un lien de note ouvre une autre de tes notes : [[Comment tes notes sont protégées]]

Les deux ont un bouton dans la barre. La chaîne fait un lien web. Les crochets font un lien de note : ils listent tes notes et tu choisis celle que tu veux. Taper `[[` fait la même chose.

Un lien de note peut aussi ouvrir une note à l'un de ses titres. Tape un `#` après le titre et choisis le titre de section : [[Comment tes notes sont protégées#Qui détient ta clé]] ouvre cette note à sa section sur la clé. L'icône de lien sur un titre dans le plan copie un tel lien pour toi.

---

*Si tu écris déjà en markdown, tape-le et la mise en forme suit. Pour voir le texte brut derrière n'importe quelle note, clique sur **Afficher le markdown** en bas à droite de cette note.*

[^1]: Voici la note. La flèche à côté te ramène en haut.
