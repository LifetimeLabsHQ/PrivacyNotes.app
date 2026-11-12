---
id: 3d0c
title: Todo lo que markdown puede hacer aquí
---

Todo lo de abajo se hizo con la barra de arriba de esta nota. Sin ajustes, sin extensiones. Selecciona texto y la barra actúa sobre él. Haz clic en una línea vacía y empieza algo nuevo.

## Palabras

Puedes poner una palabra en **negrita**, o en *cursiva*, o en ***ambas***. Puedes tacharla, ~~como esta~~. Puedes <u>subrayarla</u>. La letra pequeña va en <sub>subíndice</sub> y las potencias en <sup>superíndice</sup>.

El texto puede ser <span style="color: #e03131">rojo</span>, <span style="color: #1971c2">azul</span>, <span style="color: #2f9e44">verde</span> o cualquiera de nueve colores.

Puede ir ==resaltado en amarillo== o <mark style="background-color: rgba(64, 192, 87, 0.35)">en verde</mark>.

Un spoiler oculta palabras hasta que alguien hace clic en ellas: el regalo es ||un tocadiscos||. Selecciona las palabras y elige **Spoiler** en el menú **Insertar**, o escribe dos barras verticales a cada lado.

Un icono o un logo pueden ir dentro de una línea de texto, como :icon[gift] :icon[coffee] :icon[rocket-launch] o :logo[github]. Elige uno en **Insertar** > **Iconos y logos**.

El botón **Aa** cambia el tamaño y la fuente. El texto puede ser <span style="font-size: 0.85em">pequeño</span>, normal o <span style="font-size: 1.6em">grande</span>. Puede ser <span style="font-family: ui-sans-serif, system-ui, sans-serif">sin serifa</span>, <span style="font-family: ui-serif, Georgia, Cambria, serif">con serifa</span> o <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">monoespaciado</span>.

## Dónde se colocan las palabras

<p style="text-align: center;">Este párrafo está centrado.</p>

<p style="text-align: right;">Este está empujado a la derecha.</p>

La alineación mueve un párrafo entero, nunca una sola palabra. Pon el cursor en el párrafo y usa el botón de alineación.

## Listas

- Un punto normal
- Otro
  - Pulsa Tab para meter una línea
    - Y otra vez

1. Un paso numerado
2. Un segundo paso
3. Inserta un paso donde sea y los números se corrigen solos

- [x] Una casilla que has marcado

- [ ] Casilla

  - [ ] Pulsa Tab para indentar una tarea

  - [ ] Marca la casilla y mira la animación

- [ ] Pulsa Mayús y Tab para reducir la indentación

## Tablas

| Región | Notas | Cuota |
| --- | :---: | ---: |
| Europa | 1.204 | 48 % |
| América | 902 | 36 % |
| Asia | 401 | 16 % |
<!-- table-fill: r0=blue r1c2=green r3c2=red -->

La columna del medio está centrada y la última alineada a la derecha. Haz clic en el borde de una columna y arrastra para ensancharla. Una celda o una fila entera pueden tomar un color de la barra de la tabla. La flecha pequeña de una celda de encabezado ordena las filas de debajo, y un segundo clic las ordena al revés.

Una tabla también puede hacer cuentas. Escribe `=` en una celda para elegir una función. La celda muestra el resultado y la nota guarda la fórmula, así que haz clic en un resultado para ver cómo se calculó.

| Artículo | Cantidad | Precio | Total |
| --- | ---: | ---: | ---: |
| Café | 2 | 3.50 | =B2*C2 |
| Pastel | 1 | 4.20 | =B3*C3 |
|  |  | Suma | =SUM(D2:D3) |

## Avisos

Un aviso es una caja de color para algo que nadie debe pasar por alto. Escribe `[!` en una línea vacía para elegir uno.

> [!tip]+ Consejo
> Haz clic en su icono para plegarlo.

> [!warning]+ Advertencia
> Cada tipo tiene su color y su icono.

> [!danger]+ Peligro
> Hay muchos tipos. El menú **Insertar** los lista.

> [!fold]- Desplegable
> Sin caja ni color: solo texto que no estorba hasta que lo abres.

## Citas

> Una cita se separa del margen y lleva una línea de color a un lado.

## Notas al pie

Una nota al pie saca del texto una fuente o un comentario.[^1] Escribe `[^1]` después de una palabra, o elige **Nota al pie** en el menú **Insertar**. Haz clic en el número pequeño para ir a la nota.

## Código

El código conserva sus espacios y se colorea según el lenguaje. El nombre en la parte superior de un bloque es su lenguaje: haz clic en él para elegir otro.

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

Un bloque largo se abre plegado, para que el resto de la nota quede cerca. El botón de debajo muestra todas las líneas.

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

Un bloque de código puede llevar un título. Haz clic en el nombre del lenguaje y elige **Añadir título**. La flecha junto al título pliega el bloque en una sola línea, y la nota lo recuerda.

```bash title="backup.sh" fold
#!/bin/sh
# Copia la carpeta de notas en un archivo comprimido con fecha.
tar -czf "notes-$(date +%F).tar.gz" "$HOME/Notes"
```

Un **Cuadro para copiar** guarda una sola cosa para copiar, como una dirección o un comando. Su botón lo copia todo con un clic.

```copy
ssh-keygen -t ed25519 -C "laptop"
```

Un trozo corto de código dentro de una frase se ve así: `esto`. Mantén pulsado Cmd (Ctrl en Windows y Linux) y haz clic en él para copiarlo.

## Matemáticas

Las matemáticas pueden ir dentro de una frase, como $a^2 + b^2 = c^2$, o en su propia línea:

$$i\hbar\frac{\partial}{\partial t}\Psi = \hat{H}\Psi$$

## Imágenes

![El monte Fuji tras las flores de cerezo.](/onboarding/fuji.webp){width=50 align=center}

Arrastra una imagen a una nota, o pégala. Haz clic en ella una vez para cambiar su tamaño, o para moverla a la izquierda, al centro o a la derecha. La de arriba está a media anchura y centrada.

## Mapas

```map
35.3606, 138.7274
Monte Fuji
```

Pon un lugar en una nota con **Insertar** > **Ubicación**. El mapa viene de nuestro propio servidor, así que ninguna empresa de mapas ve dónde miras. En cualquier otra app de Markdown se lee como las coordenadas y el nombre.

## Enlaces

Hay dos tipos, y se ven distintos a propósito.

- Un enlace web abre un sitio: [privacynotes.app](https://privacynotes.app/es)
- Un enlace web puede llevar texto emergente. Pasa el puntero sobre [este](https://privacynotes.app/es/help "Nuestras páginas de ayuda") y espera.
- Un enlace de nota abre otra de tus notas: [[Cómo se protegen tus notas]]

Los dos tienen botón en la barra. La cadena hace un enlace web. Los corchetes hacen un enlace de nota: listan tus notas y eliges la que quieres. Escribir `[[` hace lo mismo.

Un enlace entre notas no tiene por qué mostrar el título de la nota. Escribe el título, una barra y luego las palabras que quieres ver en la página: [[Cómo se protegen tus notas|estas palabras]] abren esa nota.

Un enlace entre notas también puede abrir una nota en uno de sus encabezados. Escribe un `#` después del título y elige el encabezado: [[Cómo se protegen tus notas#Quién tiene tu clave]] abre esa nota en su sección sobre la clave. El icono de enlace de un encabezado en el esquema copia ese enlace por ti.

---

*Si ya escribes markdown, escríbelo y se formatea sobre la marcha. Para ver el texto en bruto de cualquier nota, pulsa **Ver markdown** abajo a la derecha de esta nota.*

[^1]: Esta es la nota. La flecha de al lado te devuelve arriba.
