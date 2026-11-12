---
id: 3d0c
title: Markdown'ın burada yapabildiği her şey
---

Aşağıdaki her şey bu notun üstündeki çubukla yapıldı. Ayar yok, eklenti yok. Bir metni seçin, çubuk onun üzerinde çalışsın. Boş bir satıra tıklayın, yeni bir şey başlatsın.

## Kelimeler

Bir kelimeyi **kalın** yapabilirsiniz, ya da *italik*, ya da ***ikisi birden***. Üstünü çizebilirsiniz, ~~şunun gibi~~. <u>Altını çizebilirsiniz</u>. Küçük yazı <sub>alt simge</sub>, üsler <sup>üst simge</sup> olur.

Metin <span style="color: #e03131">kırmızı</span>, <span style="color: #1971c2">mavi</span>, <span style="color: #2f9e44">yeşil</span> ya da dokuz renkten biri olabilir.

==Sarıyla vurgulanabilir== ya da <mark style="background-color: rgba(64, 192, 87, 0.35)">yeşille</mark>.

Sürprizbozan, biri tıklayana kadar kelimeleri gizler: hediye ||bir pikap||. Kelimeleri seçin ve **Ekle** menüsünde **Sürprizbozan** öğesini seçin ya da her iki yana iki dikey çizgi yazın.

Bir simge ya da logo metin satırının içinde durabilir, örneğin :icon[gift] :icon[coffee] :icon[rocket-launch] veya :logo[github]. **Ekle** > **Simgeler ve logolar** altından birini seçin.

**Aa** düğmesi boyutu ve yazı tipini değiştirir. Metin <span style="font-size: 0.85em">küçük</span>, normal ya da <span style="font-size: 1.6em">büyük</span> olabilir. <span style="font-family: ui-sans-serif, system-ui, sans-serif">Düz</span>, <span style="font-family: ui-serif, Georgia, Cambria, serif">tırnaklı</span> ya da <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace">eş aralıklı</span> olabilir.

## Kelimeler nerede durur

<p style="text-align: center;">Bu paragraf ortalanmış.</p>

<p style="text-align: right;">Bu ise sağa itilmiş.</p>

Hizalama bir paragrafın tamamını taşır, tek bir kelimeyi asla. İmleci paragrafa koyun ve hizalama düğmesini kullanın.

## Listeler

- Düz bir madde
- Bir tane daha
  - Bir satırı içeri almak için Tab'a basın
    - Ve bir kez daha

1. Numaralı bir adım
2. İkinci bir adım
3. Araya bir adım ekleyin, numaralar kendini düzeltsin

- [x] İşaretlediğiniz bir kutu

- [ ] Kutu

  - [ ] Bir görevi içeri almak için Tab'a basın

  - [ ] Kutuyu işaretleyin ve animasyona bakın

- [ ] Girintiyi azaltmak için Shift ve Tab'a basın

## Tablolar

| Bölge | Notlar | Pay |
| --- | :---: | ---: |
| Avrupa | 1.204 | %48 |
| Amerika | 902 | %36 |
| Asya | 401 | %16 |
<!-- table-fill: r0=blue r1c2=green r3c2=red -->

Ortadaki sütun ortalanmış, sonuncusu sağa hizalanmış. Bir sütunun kenarını sürükleyerek genişletin. Bir hücre ya da bütün bir satır, tablo çubuğundan bir renk alabilir. Başlık hücresindeki küçük ok, altındaki satırları sıralar; ikinci tıklama onları ters yönde sıralar.

Tablo toplama da yapabilir. Bir işlev seçmek için hücreye `=` yazın. Hücre sonucu gösterir, not ise formülü saklar; sonucun nasıl çıktığını görmek için sonuca tıklayın.

| Ürün | Adet | Fiyat | Toplam |
| --- | ---: | ---: | ---: |
| Kahve | 2 | 3.50 | =B2*C2 |
| Kek | 1 | 4.20 | =B3*C3 |
|  |  | Toplam | =SUM(D2:D3) |

## Bilgi kutuları

Bilgi kutusu, okuyucunun kaçırmaması gereken bir şey için renkli bir kutudur. Birini seçmek için boş bir satıra `[!` yazın.

> [!tip]+ İpucu
> Kapatmak için simgesine tıklayın.

> [!warning]+ Uyarı
> Her türün kendi rengi ve kendi simgesi vardır.

> [!danger]+ Tehlike
> Pek çok tür var. **Ekle** menüsü hepsini listeler.

> [!fold]- Katlanır
> Kutu yok, renk yok: siz açana kadar yolunuzdan çekilen bir metin.

## Alıntılar

> Bir alıntı kenar boşluğundan içeri girer ve yanında renkli bir çizgi taşır.

## Dipnotlar

Dipnot, bir kaynağı ya da ara notu metnin dışında tutar.[^1] Bir kelimeden sonra `[^1]` yazın ya da **Ekle** menüsünden **Dipnot**’u seçin. Nota gitmek için küçük numaraya tıklayın.

## Kod

Kod boşluklarını korur ve dile göre renklenir. Bloğun üstündeki ad, bloğun dilidir: başka bir dil seçmek için ona tıklayın.

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

Uzun bir blok daraltılmış olarak açılır, böylece notun geri kalanına ulaşmak için fazla kaydırmanız gerekmez. Altındaki düğme tüm satırları gösterir.

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

Bir kod bloğu başlık taşıyabilir. Dil adına tıklayın ve **Başlık ekle** öğesini seçin. Başlığın yanındaki ok bloğu tek satıra katlar ve not bunu hatırlar.

```bash title="backup.sh" fold
#!/bin/sh
# Copy the notes folder into a dated archive.
tar -czf "notes-$(date +%F).tar.gz" "$HOME/Notes"
```

**Kopyalama kutusu**, bir adres ya da komut gibi kopyalanacak tek bir şeyi tutar. Düğmesi hepsini tek tıklamayla kopyalar.

```copy
ssh-keygen -t ed25519 -C "laptop"
```

Cümlenin içindeki kısa bir kod parçası bunun yerine şöyle görünür: `bu`. Kopyalamak için Cmd tuşunu (Windows ve Linux'ta Ctrl) basılı tutup üzerine tıklayın.

## Matematik

Matematik bir cümlenin içinde durabilir, örneğin $a^2 + b^2 = c^2$, ya da kendi satırında:

$$i\hbar\frac{\partial}{\partial t}\Psi = \hat{H}\Psi$$

## Görseller

![Kiraz çiçeklerinin arkasında Fuji Dağı.](/onboarding/fuji.webp){width=50 align=center}

Bir görseli nota sürükleyin ya da yapıştırın. Boyutunu değiştirmek ya da sola, ortaya veya sağa taşımak için bir kez tıklayın. Yukarıdaki yarım genişlikte ve ortalanmış.

## Haritalar

```map
35.3606, 138.7274
Fuji Dağı
```

Bir nota **Ekle** > **Konum** ile bir yer koyun. Harita kendi sunucumuzdan gelir, bu yüzden hiçbir harita şirketi nereye baktığınızı görmez. Başka herhangi bir Markdown uygulamasında koordinatlar ve ad olarak okunur.

## Bağlantılar

İki tür var ve bilerek farklı görünürler.

- Web bağlantısı bir siteyi açar: [privacynotes.app](https://privacynotes.app/tr)
- Web bağlantısı bir ipucu metni taşıyabilir. [Bunun](https://privacynotes.app/tr/help "Yardım sayfalarımız") üzerine gelin ve bekleyin.
- Not bağlantısı başka bir notunuzu açar: [[Notlarınız nasıl korunuyor]]

İkisinin de çubukta düğmesi var. Zincir web bağlantısı yapar. Köşeli parantezler not bağlantısı yapar: notlarınızı listeler, siz de kastettiğinizi seçersiniz. `[[` yazmak da aynı şeyi yapar.

Bir not bağlantısının metni, notun başlığından farklı olabilir. Not başlığını, ardından dikey çizgiyi (|) ve sayfada görünmesini istediğiniz metni yazın.

Bir not bağlantısı, notu başlıklarından birinde de açabilir. Not başlığından sonra `#` yazın ve başlığı seçin: [[Notlarınız nasıl korunuyor#Anahtarınız kimde]] o notu anahtar bölümünde açar. Ana hattaki bir başlığın yanındaki bağlantı simgesi böyle bir bağlantıyı sizin için kopyalar.

---

*Zaten markdown yazıyorsanız yazın, yazdıkça biçimlenir. Herhangi bir notun arkasındaki ham metni görmek için bu notun sağ altındaki **Markdown'ı göster** bağlantısına tıklayın.*

[^1]: Not bu. Yanındaki ok sizi yukarı geri götürür.
