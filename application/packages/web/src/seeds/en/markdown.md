---
id: 3d0c
title: Everything markdown can do here
tags:
folder: Markdown
order: 2
---

Everything below was made with the toolbar at the top of this note. No settings, no plugins. Select some text and the toolbar acts on it. Click in an empty line and it starts something new.

## Words

You can make a word **bold**, or *italic*, or ***both***. You can put a line through it, like ~~this one~~. You can <u>underline</u> it. Small print goes in <sub>subscript</sub> and powers go in <sup>superscript</sup>.

Text can be <span style="color: #e03131">red</span>, <span style="color: #1971c2">blue</span>, <span style="color: #2f9e44">green</span> or any of nine colours.

It can be ==highlighted in yellow== or <mark style="background-color: rgba(64, 192, 87, 0.35)">in green</mark>.

A spoiler hides words until someone clicks them: the present is ||a record player||. Select the words and pick **Spoiler** in the **Insert** menu, or type two bars on each side.

An icon or a logo can sit in a line of text, like :icon[gift] :icon[coffee] :icon[rocket-launch] or :logo[github]. Pick one from **Insert** > **Icons & logos**.

The **Aa** button changes size and font. Text can be <span style="font-size: 0.85em">small</span>, normal, or <span style="font-size: 1.6em">large</span>. It can be <span style="font-family: ui-sans-serif, system-ui, sans-serif">plain</span>, <span style="font-family: ui-serif, Georgia, Cambria, serif">serif</span>, or <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">monospace</span>.

## Where the words sit

<p style="text-align: center;">This paragraph is centred.</p>

<p style="text-align: right;">This one is pushed to the right.</p>

Alignment moves a whole paragraph, never a single word. Put the cursor in the paragraph and use the alignment button.

## Lists

- A plain bullet
- Another one
  - Press Tab to move a line in
    - And again

1. A numbered step
2. A second step
3. Insert a step anywhere and the numbers correct themselves

- [x] A box you have ticked

- [ ] Checkbox

  - [ ] Press Tab to indent a Task

  - [ ] Check the box to see the animation

- [ ] Press Shift and Tab to decrease indent

## Tables

| Region | Notes | Share |
| --- | :---: | ---: |
| Europe | 1,204 | 48% |
| Americas | 902 | 36% |
| Asia | 401 | 16% |
<!-- table-fill: r0=blue r1c2=green r3c2=red -->

The middle column is centred and the last one is right-aligned. Click a column edge and drag to make it wider. A cell or a whole row can take a colour from the table bar. The small arrow in a header cell sorts the rows under it, and a second click sorts them the other way.

A table can also do sums. Type `=` in a cell to pick a function. The cell shows the answer and the note keeps the formula, so click an answer to see how it was made.

| Item | Qty | Price | Total |
| --- | ---: | ---: | ---: |
| Coffee | 2 | 3.50 | =B2*C2 |
| Cake | 1 | 4.20 | =B3*C3 |
|  |  | Sum | =SUM(D2:D3) |

## Callouts

A callout is a coloured box for something a reader must not miss. Type `[!` on an empty line to pick one.

> [!tip]+ Tip
> Click its icon to fold it shut.

> [!warning]+ Warning
> Each kind has its own colour and its own icon.

> [!danger]+ Danger
> There are many kinds. The **Insert** menu lists them.

> [!fold]- A fold
> No box and no colour: just text that stays out of the way until you open it.

## Quotes

> A quote steps in from the margin and takes a coloured line down its side.

## Footnotes

A footnote keeps a source or an aside out of the way of the text.[^1] Type `[^1]` after a word, or pick **Footnote** in the **Insert** menu. Click the small number to jump to the note.

## Code

Code keeps its spacing and gets coloured by language. The name at the top of a block is its language: click it to pick another.

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

A long block opens folded, so the rest of the note stays close. The button under it shows every line.

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

A code block can carry a title. Click the language name and pick **Add title**. The arrow beside the title folds the block down to one line, and the note remembers it.

```bash title="backup.sh" fold
#!/bin/sh
# Copy the notes folder into a dated archive.
tar -czf "notes-$(date +%F).tar.gz" "$HOME/Notes"
```

A **Copy box** holds one thing to copy, like an address or a command. Its button copies all of it in one click.

```copy
ssh-keygen -t ed25519 -C "laptop"
```

A short piece of code inside a sentence looks like `this` instead. Hold Cmd (Ctrl on Windows and Linux) and click it to copy it.

## Maths

Maths can sit inside a sentence, like $a^2 + b^2 = c^2$, or stand on its own line:

$$i\hbar\frac{\partial}{\partial t}\Psi = \hat{H}\Psi$$

## Images

![Mount Fuji behind cherry blossom.](/onboarding/fuji.webp){width=50 align=center}

Drag an image into a note, or paste it. Click it once to change its size, or to move it left, centre or right. The one above is half width and centred.

## Maps

```map
35.3606, 138.7274
Mount Fuji
```

Put a place in a note with **Insert** > **Location**. The map comes from our own server, so no map company sees where you look. In any other Markdown app it reads as the coordinates and the name.

## Links

There are two kinds, and they look different on purpose.

- A web link opens a site: [privacynotes.app](https://privacynotes.app/en)
- A web link can carry hover text. Point at [this one](https://privacynotes.app/help "Our help pages") and wait.
- A note-link opens another of your notes: [[How your notes are protected]]

Both have a toolbar button. The chain makes a web link. The brackets make a note-link: they list your notes, and you pick the one you mean. Typing `[[` does the same thing.

A note-link does not have to read as the note's title. Type the title, a bar, then the words you want on the page: [[How your notes are protected|these words]] open that note.

A note-link can also open a note at one of its headings. Type a `#` after the title and pick the heading: [[How your notes are protected#Who holds your key]] opens that note at its key section. The link icon on a heading in the outline copies such a link for you.

---

*If you already write markdown, type it and it formats as you go. To see the raw text behind any note, click on **Show markdown** at the bottom right of this note.*

[^1]: This is the note. The arrow next to it takes you back up.
