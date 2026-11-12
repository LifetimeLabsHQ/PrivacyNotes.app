---
id: 3d0c
title: Alles wat markdown hier kan
---

Alles hieronder is gemaakt met de balk boven aan deze notitie. Geen instellingen, geen plugins. Selecteer tekst en de balk werkt erop. Klik op een lege regel en hij begint iets nieuws.

## Woorden

Je kunt een woord **vet** maken, of *cursief*, of ***allebei***. Je kunt er een streep door zetten, ~~zoals hier~~. Je kunt het <u>onderstrepen</u>. Kleine letters gaan in <sub>subscript</sub> en machten in <sup>superscript</sup>.

Tekst kan <span style="color: #e03131">rood</span>, <span style="color: #1971c2">blauw</span>, <span style="color: #2f9e44">groen</span> of een van negen kleuren zijn.

Hij kan ==geel gemarkeerd== zijn of <mark style="background-color: rgba(64, 192, 87, 0.35)">groen</mark>.

Een spoiler verbergt woorden tot iemand erop klikt: het cadeau is ||een platenspeler||. Selecteer de woorden en kies **Spoiler** in het menu **Invoegen**, of typ aan elke kant twee verticale strepen.

Een icoon of een logo kan in een regel tekst staan, zoals :icon[gift] :icon[coffee] :icon[rocket-launch] of :logo[github]. Kies er een via **Invoegen** > **Iconen en logo’s**.

De knop **Aa** verandert grootte en lettertype. Tekst kan <span style="font-size: 0.85em">klein</span>, normaal of <span style="font-size: 1.6em">groot</span> zijn. Hij kan <span style="font-family: ui-sans-serif, system-ui, sans-serif">gewoon</span>, <span style="font-family: ui-serif, Georgia, Cambria, serif">met schreef</span> of <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">monospace</span> zijn.

## Waar de woorden staan

<p style="text-align: center;">Deze alinea staat in het midden.</p>

<p style="text-align: right;">Deze is naar rechts geduwd.</p>

Uitlijnen verplaatst een hele alinea, nooit één woord. Zet de cursor in de alinea en gebruik de uitlijnknop.

## Lijsten

- Een gewoon bolletje
- Nog een
  - Druk op Tab om een regel in te springen
    - En nog eens

1. Een genummerde stap
2. Een tweede stap
3. Voeg ergens een stap toe en de nummers verbeteren zichzelf

- [x] Een vakje dat je hebt afgevinkt

- [ ] Vakje

  - [ ] Druk op Tab om een taak in te springen

  - [ ] Vink het vakje aan en kijk naar de animatie

- [ ] Druk op Shift en Tab om minder in te springen

## Tabellen

| Regio | Notities | Aandeel |
| --- | :---: | ---: |
| Europa | 1.204 | 48 % |
| Amerika | 902 | 36 % |
| Azië | 401 | 16 % |
<!-- table-fill: r0=blue r1c2=green r3c2=red -->

De middelste kolom staat gecentreerd en de laatste rechts. Sleep aan de rand van een kolom om hem breder te maken. Een cel of een hele rij krijgt een kleur via de tabelbalk. Het pijltje in een kopcel sorteert de rijen eronder, en een tweede klik sorteert ze andersom.

Een tabel kan ook rekenen. Typ `=` in een cel om een functie te kiezen. De cel toont de uitkomst en de notitie bewaart de formule, dus klik op een uitkomst om te zien hoe die tot stand kwam.

| Artikel | Aantal | Prijs | Totaal |
| --- | ---: | ---: | ---: |
| Koffie | 2 | 3.50 | =B2*C2 |
| Taart | 1 | 4.20 | =B3*C3 |
|  |  | Som | =SUM(D2:D3) |

## Aandachtsblokken

Een aandachtsblok is een gekleurd vak voor iets dat een lezer niet mag missen. Typ `[!` op een lege regel om er een te kiezen.

> [!tip]+ Tip
> Klik op het pictogram om het dicht te klappen.

> [!warning]+ Let op
> Elk soort heeft zijn eigen kleur en icoon.

> [!danger]+ Gevaar
> Er zijn er veel. Het menu **Invoegen** somt ze op.

> [!fold]- Inklapbaar
> Geen kader en geen kleur: alleen tekst die uit de weg blijft tot je hem openklapt.

## Citaten

> Een citaat springt in vanaf de kantlijn en krijgt een gekleurde streep aan de zijkant.

## Voetnoten

Een voetnoot houdt een bron of een zijopmerking uit de tekst.[^1] Typ `[^1]` na een woord, of kies **Voetnoot** in het menu **Invoegen**. Klik op het kleine nummer om naar de noot te gaan.

## Code

Code houdt zijn spaties en wordt gekleurd per taal. De naam boven aan een blok is de taal: klik erop om een andere te kiezen.

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

Een lang blok opent ingeklapt, zodat de rest van de notitie dichtbij blijft. De knop eronder toont alle regels.

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

Een codeblok kan een titel hebben. Klik op de naam van de taal en kies **Titel toevoegen**. Met het pijltje naast de titel klap je het blok in tot één regel, en de notitie onthoudt dat.

```bash title="backup.sh" fold
#!/bin/sh
# Kopieer de map met notities naar een archief met datum.
tar -czf "notes-$(date +%F).tar.gz" "$HOME/Notes"
```

Een **Kopieervak** bevat één ding om te kopiëren, zoals een adres of een opdracht. De knop kopieert alles in één klik.

```copy
ssh-keygen -t ed25519 -C "laptop"
```

Een kort stukje code midden in een zin ziet er zo uit: `dit`. Houd Cmd (Ctrl op Windows en Linux) ingedrukt en klik erop om het te kopiëren.

## Wiskunde

Wiskunde kan in een zin staan, zoals $a^2 + b^2 = c^2$, of op een eigen regel:

$$i\hbar\frac{\partial}{\partial t}\Psi = \hat{H}\Psi$$

## Afbeeldingen

![De Fuji achter kersenbloesem.](/onboarding/fuji.webp){width=50 align=center}

Sleep een afbeelding in een notitie, of plak er een. Klik erop om de grootte te veranderen, of om hem links, in het midden of rechts te zetten. Die hierboven is halve breedte en gecentreerd.

## Kaarten

```map
35.3606, 138.7274
Fuji
```

Zet een plaats in een notitie met **Invoegen** > **Locatie**. De kaart komt van onze eigen server, dus geen kaartenbedrijf ziet waar je kijkt. In elke andere Markdown-app lees je hem als de coördinaten en de naam.

## Links

Er zijn twee soorten, en ze zien er met opzet anders uit.

- Een weblink opent een site: [privacynotes.app](https://privacynotes.app/nl)
- Een weblink kan een tekst tonen als je erboven zweeft. Wijs [deze](https://privacynotes.app/nl/help "Onze hulppagina's") aan en wacht even.
- Een notitielink opent een andere notitie van jou: [[Hoe je notities beschermd zijn]]

Allebei hebben een knop in de balk. De ketting maakt een weblink. De haakjes maken een notitielink: ze sommen je notities op, en jij kiest welke je bedoelt. `[[` typen doet hetzelfde.

Een notitielink hoeft niet de titel van de notitie weer te geven. Typ de titel, een verticale streep en daarna de woorden die je op de pagina wilt zien: [[Hoe je notities beschermd zijn|deze woorden]] openen die notitie.

Een notitielink kan een notitie ook bij een van haar koppen openen. Typ een `#` na de titel en kies de kop: [[Hoe je notities beschermd zijn#Wie je sleutel heeft]] opent die notitie bij het onderdeel over de sleutel. Het linkpictogram bij een kop in het overzicht kopieert zo'n link voor je.

---

*Schrijf je al markdown, typ het dan gewoon en het maakt zichzelf op. De ruwe tekst achter een notitie zie je met **Markdown tonen** rechtsonder in deze notitie.*

[^1]: Dit is de noot. De pijl ernaast brengt je terug naar boven.
