/**
 * A one-page PDF around a JPEG, no library and no font: the JPEG goes in
 * as it is (DCTDecode), and the page is the picture.
 */
import { PAPER, type Paper } from './pageWarp';

/** Width, height and color channels from the JPEG's frame header. */
export function jpegInfo(j: Uint8Array): { width: number; height: number; comps: number } {
  if (j[0] !== 0xff || j[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  while (i + 9 < j.length) {
    if (j[i] !== 0xff) { i++; continue; }
    const m = j[i + 1];
    if (m === 0xff) { i++; continue; }
    const len = (j[i + 2]! << 8) | j[i + 3]!;
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC).
    if (m! >= 0xc0 && m! <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: (j[i + 5]! << 8) | j[i + 6]!, width: (j[i + 7]! << 8) | j[i + 8]!, comps: j[i + 9]! };
    }
    i += 2 + len;
  }
  throw new Error('JPEG has no frame header');
}

/**
 * The page is A4 or Letter when the scan snapped to one; any other shape
 * keeps its ratio with its long edge as long as A4's (or Letter's).
 */
export function jpegToPdf(jpeg: Uint8Array, paper: Paper, fallback: 'a4' | 'letter' = 'a4'): Uint8Array<ArrayBuffer> {
  const { width, height, comps } = jpegInfo(jpeg);
  if (comps !== 1 && comps !== 3) throw new Error('only gray or RGB JPEG');
  const longPt = PAPER[paper ?? fallback].longPt;
  const r = width / height;
  const pw = +(r >= 1 ? longPt : longPt * r).toFixed(2);
  const ph = +(r >= 1 ? longPt / r : longPt).toFixed(2);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const put = (b: Uint8Array | string) => {
    const u = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(u);
    pos += u.length;
  };
  const obj = (n: number, body: string) => { offsets[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // says "binary file" to old tools
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = pos;
  put(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
  put(jpeg);
  put('\nendstream\nendobj\n');
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = pos;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  put(`${x}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
