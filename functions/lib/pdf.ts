// Minimal, dependency-free PDF writer for the customer inspection report.
// Runs entirely in the Worker (no Browser Rendering, no paid add-ons, no npm
// runtime deps — same rule as the rest of functions/). Base-14 Helvetica
// family (nothing embedded), WinAnsi text, JPEG photos via DCTDecode, flowing
// layout with automatic page breaks, per-page footer with version + timestamp.

export type Rgb = [number, number, number];

export const PDF_COLORS = {
  navy: [0.039, 0.07, 0.149] as Rgb,
  blue: [0.184, 0.42, 1.0] as Rgb,
  text: [0.118, 0.141, 0.204] as Rgb,
  grey: [0.43, 0.47, 0.55] as Rgb,
  red: [0.784, 0.275, 0.29] as Rgb,
  amber: [0.784, 0.51, 0.078] as Rgb,
  green: [0.118, 0.588, 0.373] as Rgb,
  line: [0.82, 0.85, 0.9] as Rgb,
  white: [1, 1, 1] as Rgb,
};

// Helvetica advance widths (per 1000 units) — standard Adobe base-14 metrics
// for the ASCII range; anything unknown falls back to 556 (safe over-estimate
// keeps wrapped lines inside the margins).
const HELV: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667,
  Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222,
  m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500,
  y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584,
};

function textWidth(s: string, size: number, bold: boolean): number {
  let units = 0;
  for (const ch of s) units += HELV[ch] ?? 556;
  return (units / 1000) * size * (bold ? 1.08 : 1);
}

// Unicode → WinAnsi single-byte mapping for the punctuation the report uses.
const WINANSI: Record<string, number> = {
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97,
  '•': 0x95, '…': 0x85, '°': 0xb0, 'é': 0xe9, '©': 0xa9, '′': 0x27,
  '″': 0x22, '½': 0xbd, '¼': 0xbc, '¾': 0xbe, '×': 0xd7, '·': 0xb7,
};

function encodePdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63;
    let byte: number;
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += `\\${ch}`;
      continue;
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
      continue;
    } else if (WINANSI[ch] !== undefined) {
      byte = WINANSI[ch]!;
    } else if (code >= 0xa0 && code <= 0xff) {
      byte = code;
    } else {
      byte = 63; // '?'
    }
    out += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return out;
}

/** Parse JPEG dimensions from the SOF marker. Returns null when not a JPEG. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2]! << 8) | bytes[i + 3]!) >>> 0;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

export interface PdfJpeg {
  data: Uint8Array;
  width: number;
  height: number;
}

interface PageState {
  content: string[];
  images: Map<string, number>; // resource name -> object id
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN_X = 54;
const TOP_Y = PAGE_H - 58;
const BOTTOM_Y = 64;
const CONTENT_W = PAGE_W - MARGIN_X * 2;

export class ReportPdf {
  private pages: PageState[] = [];
  private cursorY = TOP_Y;
  private imageObjects: Array<{ id: number; jpeg: PdfJpeg }> = [];
  private nextObjId = 1;
  private footerLeft: string;
  private footerRight: string;

  constructor(opts: { footerLeft: string; footerRight: string }) {
    this.footerLeft = opts.footerLeft;
    this.footerRight = opts.footerRight;
    this.addPage();
  }

  private page(): PageState {
    return this.pages[this.pages.length - 1]!;
  }

  addPage(): void {
    this.pages.push({ content: [], images: new Map() });
    this.cursorY = TOP_Y;
  }

  /** Ensure at least `h` points of room; break the page when needed. */
  need(h: number): void {
    if (this.cursorY - h < BOTTOM_Y) this.addPage();
  }

  get y(): number {
    return this.cursorY;
  }

  gap(h: number): void {
    this.cursorY -= h;
  }

  private setFill(c: Rgb): string {
    return `${c[0].toFixed(3)} ${c[1].toFixed(3)} ${c[2].toFixed(3)} rg`;
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    this.page().content.push(`${this.setFill(color)} ${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
  }

  hr(color: Rgb = PDF_COLORS.line): void {
    this.need(6);
    this.rect(MARGIN_X, this.cursorY, CONTENT_W, 0.7, color);
    this.cursorY -= 6;
  }

  private rawText(x: number, y: number, text: string, size: number, opts: { bold?: boolean; italic?: boolean; color?: Rgb } = {}): void {
    const font = opts.bold ? 'F2' : opts.italic ? 'F3' : 'F1';
    const c = opts.color ?? PDF_COLORS.text;
    this.page().content.push(
      `BT ${this.setFill(c)} /${font} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${encodePdfText(text)}) Tj ET`,
    );
  }

  /** Wrap text to a width. Returns the wrapped lines (measurement only). */
  static wrap(text: string, size: number, width: number, bold = false): string[] {
    const lines: string[] = [];
    for (const para of String(text).split(/\r?\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      if (words.length === 0) {
        lines.push('');
        continue;
      }
      let line = '';
      for (const w of words) {
        const candidate = line ? `${line} ${w}` : w;
        if (textWidth(candidate, size, bold) <= width || !line) line = candidate;
        else {
          lines.push(line);
          line = w;
        }
      }
      if (line) lines.push(line);
    }
    return lines;
  }

  /** Flowing paragraph with wrapping + page breaks. */
  para(
    text: string,
    opts: { size?: number; bold?: boolean; italic?: boolean; color?: Rgb; x?: number; width?: number; lineGap?: number; after?: number } = {},
  ): void {
    const size = opts.size ?? 10;
    const x = opts.x ?? MARGIN_X;
    const width = opts.width ?? PAGE_W - MARGIN_X - x;
    const lineH = size * 1.32 + (opts.lineGap ?? 0);
    const lines = ReportPdf.wrap(text, size, width, opts.bold);
    for (const line of lines) {
      this.need(lineH);
      this.cursorY -= lineH;
      if (line) this.rawText(x, this.cursorY, line, size, opts);
    }
    this.cursorY -= opts.after ?? 4;
  }

  /** Single-line label (no wrap) at the current cursor. */
  line(text: string, opts: { size?: number; bold?: boolean; italic?: boolean; color?: Rgb; x?: number } = {}): void {
    const size = opts.size ?? 10;
    const lineH = size * 1.35;
    this.need(lineH);
    this.cursorY -= lineH;
    this.rawText(opts.x ?? MARGIN_X, this.cursorY, text, size, opts);
  }

  /** Section heading in brand blue with a rule under it. */
  heading(text: string): void {
    this.need(34);
    this.cursorY -= 20;
    this.rawText(MARGIN_X, this.cursorY, text, 12.5, { bold: true, color: PDF_COLORS.blue });
    this.cursorY -= 5;
    this.rect(MARGIN_X, this.cursorY, CONTENT_W, 0.8, PDF_COLORS.line);
    this.cursorY -= 8;
  }

  /** Two-column key/value row. */
  kv(label: string, value: string): void {
    const size = 9.5;
    const labelW = 150;
    const valueW = CONTENT_W - labelW - 8;
    const lines = ReportPdf.wrap(value || '—', size, valueW, true);
    const h = Math.max(1, lines.length) * size * 1.35 + 3;
    this.need(h);
    const topY = this.cursorY - size * 1.35;
    this.rawText(MARGIN_X, topY, label, size, { color: PDF_COLORS.grey });
    let y = topY;
    for (const l of lines) {
      this.rawText(MARGIN_X + labelW, y, l, size, { bold: true });
      y -= size * 1.35;
    }
    this.cursorY = y - 3 + size * 0.35;
  }

  /**
   * A finding row: severity tag, title + wrapped description, optional cost.
   * Kept together when it fits; otherwise breaks before the row.
   */
  finding(sev: string, sevColor: Rgb, title: string, desc: string | null, cost: string | null): void {
    const bodyX = MARGIN_X + 78;
    const costW = cost ? 86 : 0;
    const bodyW = PAGE_W - MARGIN_X - bodyX - costW - (cost ? 8 : 0);
    const descLines = desc ? ReportPdf.wrap(desc, 9, bodyW) : [];
    const titleLines = ReportPdf.wrap(title, 10, bodyW, true);
    const blockH = titleLines.length * 13.5 + descLines.length * 11.9 + 10;
    this.need(Math.min(blockH, TOP_Y - BOTTOM_Y));

    let y = this.cursorY - 13.5;
    this.rawText(MARGIN_X, y, sev.toUpperCase(), 8, { bold: true, color: sevColor });
    if (cost) {
      const w = textWidth(cost, 9, false);
      this.rawText(PAGE_W - MARGIN_X - w, y, cost, 9, { color: PDF_COLORS.grey });
    }
    for (const [i, l] of titleLines.entries()) {
      if (i > 0) y -= 13.5;
      this.rawText(bodyX, y, l, 10, { bold: true });
    }
    for (const l of descLines) {
      y -= 11.9;
      this.need(0);
      this.rawText(bodyX, y, l, 9, { color: PDF_COLORS.grey });
    }
    this.cursorY = y - 8;
    if (this.cursorY < BOTTOM_Y) this.addPage();
  }

  /** Embed a JPEG photo scaled into the content width, with caption. */
  photo(jpeg: PdfJpeg, caption: string | null): void {
    const maxW = Math.min(CONTENT_W, 300);
    const scale = Math.min(maxW / jpeg.width, 340 / jpeg.height, 1);
    const w = jpeg.width * scale;
    const h = jpeg.height * scale;
    const capH = caption ? 14 : 0;
    this.need(h + capH + 10);
    this.cursorY -= h;
    const id = this.nextObjId++;
    this.imageObjects.push({ id, jpeg });
    const name = `Im${id}`;
    this.page().images.set(name, id);
    this.page().content.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${MARGIN_X} ${this.cursorY.toFixed(1)} cm /${name} Do Q`);
    if (caption) {
      this.cursorY -= 13;
      this.rawText(MARGIN_X, this.cursorY, caption.slice(0, 110), 8.5, { italic: true, color: PDF_COLORS.grey });
    }
    this.cursorY -= 10;
  }

  /** The branded first-page header band. Call once, first. */
  brandHeader(rightLines: string[]): void {
    const bandH = 64;
    this.rect(0, PAGE_H - bandH, PAGE_W, bandH, PDF_COLORS.navy);
    this.rawText(MARGIN_X, PAGE_H - 30, 'AutoClarity', 19, { bold: true, color: PDF_COLORS.white });
    this.rawText(MARGIN_X, PAGE_H - 46, 'Pre-Purchase Inspection Report', 10, { color: [0.72, 0.78, 0.9] });
    let y = PAGE_H - 22;
    for (const l of rightLines) {
      const w = textWidth(l, 8.5, false);
      this.rawText(PAGE_W - MARGIN_X - w, y, l, 8.5, { color: [0.72, 0.78, 0.9] });
      y -= 11.5;
    }
    this.cursorY = PAGE_H - bandH - 14;
  }

  /** Big score + verdict banner. */
  verdictBanner(scoreText: string, verdictLabel: string, color: Rgb): void {
    const h = 58;
    this.need(h + 8);
    this.cursorY -= h;
    const y = this.cursorY;
    this.rect(MARGIN_X, y, CONTENT_W, h, [0.955, 0.963, 0.975]);
    this.rect(MARGIN_X, y, 3.5, h, color);
    this.rawText(MARGIN_X + 18, y + h - 38, scoreText, 26, { bold: true });
    this.rawText(MARGIN_X + 18, y + 10, 'Overall condition score (1-10)', 8, { color: PDF_COLORS.grey });
    const vw = textWidth(verdictLabel, 15, true) * 1.08;
    this.rawText(PAGE_W - MARGIN_X - vw - 18, y + h - 34, verdictLabel, 15, { bold: true, color });
    const recw = textWidth('Overall recommendation', 8, false);
    this.rawText(PAGE_W - MARGIN_X - recw - 18, y + 10, 'Overall recommendation', 8, { color: PDF_COLORS.grey });
    this.cursorY -= 10;
  }

  /** Serialize to PDF bytes. */
  bytes(): Uint8Array {
    // Object layout: 1 Catalog, 2 Pages, 3-5 Fonts, then per-image objects,
    // then per-page (Page + Contents) pairs.
    const objects = new Map<number, Uint8Array>();
    const enc = new TextEncoder();
    let maxId = 5;
    for (const im of this.imageObjects) maxId = Math.max(maxId, im.id);
    const pageIds: number[] = [];
    const contentIds: number[] = [];
    let id = maxId + 1;
    for (let i = 0; i < this.pages.length; i++) {
      pageIds.push(id++);
      contentIds.push(id++);
    }

    objects.set(1, enc.encode(`<< /Type /Catalog /Pages 2 0 R >>`));
    objects.set(2, enc.encode(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`));
    objects.set(3, enc.encode(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`));
    objects.set(4, enc.encode(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`));
    objects.set(5, enc.encode(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`));

    for (const im of this.imageObjects) {
      const head = enc.encode(
        `<< /Type /XObject /Subtype /Image /Width ${im.jpeg.width} /Height ${im.jpeg.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.data.length} >>\nstream\n`,
      );
      const tail = enc.encode(`\nendstream`);
      const buf = new Uint8Array(head.length + im.jpeg.data.length + tail.length);
      buf.set(head, 0);
      buf.set(im.jpeg.data, head.length);
      buf.set(tail, head.length + im.jpeg.data.length);
      objects.set(im.id, buf);
    }

    this.pages.forEach((page, i) => {
      // Footer (drawn last so total page count is known).
      const footer: string[] = [];
      const fLeft = this.footerLeft;
      const fRight = `${this.footerRight}  ·  Page ${i + 1} of ${this.pages.length}`;
      footer.push(`${PDF_COLORS.line[0]} ${PDF_COLORS.line[1]} ${PDF_COLORS.line[2]} rg ${MARGIN_X} 46 ${CONTENT_W} 0.7 re f`);
      footer.push(
        `BT ${PDF_COLORS.grey[0].toFixed(3)} ${PDF_COLORS.grey[1].toFixed(3)} ${PDF_COLORS.grey[2].toFixed(3)} rg /F1 7.5 Tf ${MARGIN_X} 34 Td (${encodePdfText(fLeft)}) Tj ET`,
      );
      const rw = textWidth(fRight, 7.5, false);
      footer.push(
        `BT ${PDF_COLORS.grey[0].toFixed(3)} ${PDF_COLORS.grey[1].toFixed(3)} ${PDF_COLORS.grey[2].toFixed(3)} rg /F1 7.5 Tf ${(PAGE_W - MARGIN_X - rw).toFixed(1)} 34 Td (${encodePdfText(fRight)}) Tj ET`,
      );

      const stream = [...page.content, ...footer].join('\n');
      const streamBytes = enc.encode(stream);
      const contentObj = new Uint8Array(enc.encode(`<< /Length ${streamBytes.length} >>\nstream\n`).length + streamBytes.length + enc.encode(`\nendstream`).length);
      const h2 = enc.encode(`<< /Length ${streamBytes.length} >>\nstream\n`);
      contentObj.set(h2, 0);
      contentObj.set(streamBytes, h2.length);
      contentObj.set(enc.encode(`\nendstream`), h2.length + streamBytes.length);
      objects.set(contentIds[i]!, contentObj);

      const xobjects = [...page.images.entries()].map(([name, objId]) => `/${name} ${objId} 0 R`).join(' ');
      objects.set(
        pageIds[i]!,
        enc.encode(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
            `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ''} >> ` +
            `/Contents ${contentIds[i]} 0 R >>`,
        ),
      );
    });

    // Assemble with xref.
    const ids = [...objects.keys()].sort((a, b) => a - b);
    const chunks: Uint8Array[] = [enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
    let offset = chunks[0]!.length;
    const offsets = new Map<number, number>();
    for (const oid of ids) {
      offsets.set(oid, offset);
      const head = enc.encode(`${oid} 0 obj\n`);
      const body = objects.get(oid)!;
      const tail = enc.encode(`\nendobj\n`);
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    }
    const maxObj = ids[ids.length - 1]!;
    let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
    for (let oid = 1; oid <= maxObj; oid++) {
      const off = offsets.get(oid);
      xref += off === undefined ? `0000000000 65535 f \n` : `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(enc.encode(xref + trailer));

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }
}
