---
id: 3d0c
title: Tot el que el markdown pot fer aquí
---

Tot el que hi ha a sota s'ha fet amb la barra de dalt d'aquesta nota. Sense configuració, sense connectors. Selecciona text i la barra hi actua. Fes clic en una línia buida i comença una cosa nova.

## Paraules

Pots posar una paraula en **negreta**, o en *cursiva*, o ***totes dues***. La pots ratllar, ~~com aquesta~~. La pots <u>subratllar</u>. La lletra petita va en <sub>subíndex</sub> i les potències en <sup>superíndex</sup>.

El text pot ser <span style="color: #e03131">vermell</span>, <span style="color: #1971c2">blau</span>, <span style="color: #2f9e44">verd</span> o d'un dels nou colors.

Pot anar ==ressaltat en groc== o <mark style="background-color: rgba(64, 192, 87, 0.35)">en verd</mark>.

Un espòiler amaga paraules fins que algú hi fa clic: el regal és ||un tocadiscos||. Selecciona les paraules i tria **Espòiler** al menú **Insereix**, o escriu dues barres a cada costat.

Una icona o un logotip poden anar dins d'una línia de text, com :icon[gift] :icon[coffee] :icon[rocket-launch] o :logo[github]. Tria'n un a **Insereix** > **Icones i logotips**.

El botó **Aa** canvia la mida i la tipografia. El text pot ser <span style="font-size: 0.85em">petit</span>, normal o <span style="font-size: 1.6em">gran</span>. Pot ser <span style="font-family: ui-sans-serif, system-ui, sans-serif">senzill</span>, <span style="font-family: ui-serif, Georgia, Cambria, serif">amb serifa</span> o <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">monoespaiat</span>.

## On seuen les paraules

<p style="text-align: center;">Aquest paràgraf està centrat.</p>

<p style="text-align: right;">Aquest està empès a la dreta.</p>

L'alineació mou un paràgraf sencer, mai una sola paraula. Posa el cursor al paràgraf i fes servir el botó d'alineació.

## Llistes

- Un pic senzill
- Un altre
  - Prem Tab per endinsar una línia
    - I un altre cop

1. Un pas numerat
2. Un segon pas
3. Insereix un pas on vulguis i els números es corregeixen sols

- [x] Una casella que has marcat

- [ ] Casella

  - [ ] Prem Tab per endinsar una tasca

  - [ ] Marca la casella i mira l'animació

- [ ] Prem Maj i Tab per reduir el sagnat

## Taules

| Regió | Notes | Quota |
| --- | :---: | ---: |
| Europa | 1.204 | 48 % |
| Amèrica | 902 | 36 % |
| Àsia | 401 | 16 % |
<!-- table-fill: r0=blue r1c2=green r3c2=red -->

La columna del mig està centrada i l'última alineada a la dreta. Fes clic a la vora d'una columna i arrossega-la per eixamplar-la. Una cel·la o una fila sencera poden agafar un color de la barra de la taula. La fletxa petita d'una cel·la de capçalera ordena les files de sota, i un segon clic les ordena a l'inrevés.

Una taula també pot fer sumes. Escriu `=` en una cel·la per triar una funció. La cel·la mostra el resultat i la nota guarda la fórmula, així que fes clic en un resultat per veure com s'ha calculat.

| Article | Quantitat | Preu | Total |
| --- | ---: | ---: | ---: |
| Cafè | 2 | 3.50 | =B2*C2 |
| Pastís | 1 | 4.20 | =B3*C3 |
|  |  | Suma | =SUM(D2:D3) |

## Requadres

Un requadre és una caixa de color per a una cosa que ningú no ha de perdre's. Escriu `[!` en una línia buida per triar-ne un.

> [!tip]+ Consell
> Fes clic a la icona per plegar-lo.

> [!warning]+ Atenció
> Cada mena té el seu color i la seva icona.

> [!danger]+ Perill
> N'hi ha molts. El menú **Insereix** els llista.

> [!fold]- Un plegable
> Sense requadre ni color: només text que no fa nosa fins que l'obres.

## Cites

> Una cita s'endinsa des del marge i porta una línia de color al costat.

## Notes a peu de pàgina

Una nota a peu de pàgina treu del text una font o un comentari.[^1] Escriu `[^1]` després d’una paraula, o tria **Nota a peu de pàgina** al menú **Insereix**. Fes clic al número petit per anar a la nota.

## Codi

El codi manté els espais i es pinta segons el llenguatge. El nom a la part de dalt d’un bloc és el seu llenguatge: fes-hi clic per triar-ne un altre.

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

Un bloc llarg s’obre plegat, perquè la resta de la nota quedi a prop. El botó de sota mostra totes les línies.

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

Un bloc de codi pot portar un títol. Fes clic al nom del llenguatge i tria **Afegeix un títol**. La fletxa del costat del títol plega el bloc en una sola línia, i la nota se'n recorda.

```bash title="backup.sh" fold
#!/bin/sh
# Copia la carpeta de notes en un arxiu amb data.
tar -czf "notes-$(date +%F).tar.gz" "$HOME/Notes"
```

Un **Quadre per copiar** guarda una sola cosa per copiar, com una adreça o una ordre. El seu botó ho copia tot d'un sol clic.

```copy
ssh-keygen -t ed25519 -C "laptop"
```

Un tros curt de codi dins d'una frase es veu així: `això`. Mantén premuda la tecla Cmd (Ctrl a Windows i Linux) i fes-hi clic per copiar-lo.

## Matemàtiques

Les matemàtiques poden anar dins d'una frase, com ara $a^2 + b^2 = c^2$, o en una línia pròpia:

$$i\hbar\frac{\partial}{\partial t}\Psi = \hat{H}\Psi$$

## Imatges

![El mont Fuji darrere les flors de cirerer.](/onboarding/fuji.webp){width=50 align=center}

Arrossega una imatge a una nota, o enganxa-la. Fes-hi clic un cop per canviar-ne la mida, o per moure-la a l'esquerra, al centre o a la dreta. La de dalt està a mitja amplada i centrada.

## Mapes

```map
35.3606, 138.7274
Mont Fuji
```

Posa un lloc en una nota amb **Insereix** > **Ubicació**. El mapa ve del nostre propi servidor, així que cap empresa de mapes veu on mires. En qualsevol altra app de Markdown es llegeix com les coordenades i el nom.

## Enllaços

N'hi ha de dues menes, i es veuen diferents a propòsit.

- Un enllaç web obre un lloc: [privacynotes.app](https://privacynotes.app/ca)
- Un enllaç web pot portar un text emergent. Passa el punter per sobre d'[aquest](https://privacynotes.app/ca/help "Les nostres pàgines d'ajuda") i espera.
- Un enllaç de nota obre una altra nota teva: [[Com estan protegides les teves notes]]

Tots dos tenen botó a la barra. La cadena fa un enllaç web. Els claudàtors fan un enllaç de nota: llisten les teves notes i tries la que vols. Escriure `[[` fa el mateix.

Un enllaç entre notes no ha de mostrar per força el títol de la nota. Escriu el títol, una barra vertical i les paraules que vols a la pàgina: [[Com estan protegides les teves notes|aquestes paraules]] obren aquesta nota.

Un enllaç entre notes també pot obrir una nota en un dels seus encapçalaments. Escriu un `#` després del títol i tria l'encapçalament: [[Com estan protegides les teves notes#Qui té la teva clau]] obre aquesta nota a la secció sobre la clau. La icona d'enllaç d'un encapçalament a l'esquema copia aquest enllaç per tu.

---

*Si ja escrius markdown, escriu-lo i es formata sobre la marxa. Per veure el text en brut darrere de qualsevol nota, fes clic a **Mostra el markdown** a baix a la dreta d'aquesta nota.*

[^1]: Aquesta és la nota. La fletxa del costat et torna a dalt.
