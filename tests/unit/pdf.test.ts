// Unit tests: the dependency-free PDF writer and the report→PDF renderer.
// The writer leaves text streams uncompressed, so tests can assert on content.
import { describe, expect, it } from 'vitest';
import { ReportPdf, jpegDimensions } from '../../functions/lib/pdf.ts';
import { renderReportPdf } from '../../functions/lib/report-pdf.ts';

function pdfText(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

// A minimal valid 2x1 JPEG (SOI, APP0, SOF0, ..., EOI) for dimension parsing.
function tinyJpeg(width: number, height: number): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...sof, 0xff, 0xd9]);
}

describe('pdf writer', () => {
  it('produces a structurally valid PDF with xref and trailer', () => {
    const pdf = new ReportPdf({ footerLeft: 'AutoClarity', footerRight: 'Version 1' });
    pdf.heading('Test heading');
    pdf.para('Hello inspection world.');
    const text = pdfText(pdf.bytes());
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Page ');
    expect(text).toContain('xref');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('(Hello inspection world.) Tj');
  });

  it('breaks pages automatically on long content', () => {
    const pdf = new ReportPdf({ footerLeft: 'x', footerRight: 'y' });
    for (let i = 0; i < 120; i++) pdf.para(`Line ${i} of a long report used to force pagination.`);
    const text = pdfText(pdf.bytes());
    const pages = (text.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain(`Page 1 of ${pages}`);
  });

  it('escapes parentheses and maps smart punctuation to WinAnsi', () => {
    const pdf = new ReportPdf({ footerLeft: 'x', footerRight: 'y' });
    pdf.para('Cost (est.) — “quoted” 3/32” isn’t bad');
    const text = pdfText(pdf.bytes());
    expect(text).toContain('\\(est.\\)');
    expect(text).toContain('\\227'); // em dash
    expect(text).toContain('\\222'); // right single quote
  });

  it('embeds JPEG images as DCTDecode XObjects', () => {
    const pdf = new ReportPdf({ footerLeft: 'x', footerRight: 'y' });
    pdf.photo({ data: tinyJpeg(640, 480), width: 640, height: 480 }, 'A caption');
    const text = pdfText(pdf.bytes());
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Width 640');
    expect(text).toContain('(A caption) Tj');
  });
});

describe('jpegDimensions', () => {
  it('parses SOF dimensions', () => {
    expect(jpegDimensions(tinyJpeg(1234, 987))).toEqual({ width: 1234, height: 987 });
  });
  it('rejects non-JPEG data', () => {
    expect(jpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe('report pdf renderer', () => {
  const payload = {
    schema: 'autoclarity.ppi.report',
    version: 2,
    kind: 'amendment',
    amendmentReason: 'Corrected measurements',
    publishedAt: '2026-07-23T18:00:00.000Z',
    inspector: 'Faheb Brown',
    ref: 'PPI-TEST-0001',
    customer: { name: 'Test Customer' },
    vehicle: { year: 2017, make: 'Lexus', model: 'RX 350', trim: 'F Sport', vin: 'VIN123', vinCheck: 'matches', odometerMiles: 61250, titleStatus: 'clean' },
    seller: { type: 'dealership', name: null, notes: null },
    location: { city: 'Las Vegas', state: 'NV' },
    inspectedAt: '2026-07-23T17:00:00.000Z',
    appointment: { startsAt: null, endsAt: null },
    overall: {
      score: 7.5,
      verdict: 'negotiate_repair_first',
      verdictLabel: 'Negotiate / Repair First',
      executiveSummary: 'A solid example with two documented asks.',
      positiveFindings: 'Strong cold start.',
      negotiationSummary: 'Tires and the belt.',
    },
    rollups: {
      counts: { pass: 90, attention: 2, fail: 1, notInspected: 1, notApplicable: 0 },
      safetyItems: ['safety_restraints.seat_belts'],
      immediateItems: [],
      soonItems: ['tires_wheels.tread_rl'],
      monitorItems: [],
      negotiationItems: ['tires_wheels.tread_rl'],
      estimatedCostLowCents: 65000,
      estimatedCostHighCents: 125000,
    },
    sections: [
      {
        key: 'tires_wheels', title: 'Tires & Wheels', performed: 'performed', notPerformedReason: null, summary: null,
        items: [
          { key: 'tires_wheels.tread_rl', label: 'Rear-left tire tread', result: 'attention', notInspectedReason: null, note: 'Replace soon.', measurement: { value: '4', unit: '32nds in', label: 'Tread depth' }, costLowCents: 50000, costHighCents: 90000, priority: 'soon', safetyCritical: false, negotiationItem: true, photos: [{ id: 'rph_1', caption: 'Tread', contentType: 'image/jpeg', width: 640, height: 480 }] },
        ],
      },
      {
        key: 'safety_restraints', title: 'Seats, Restraints & Safety Equipment', performed: 'performed', notPerformedReason: null, summary: null,
        items: [
          { key: 'safety_restraints.seat_belts', label: 'Seat belts (all positions)', result: 'fail', notInspectedReason: null, note: 'Frayed webbing — replace.', measurement: null, costLowCents: 15000, costHighCents: 35000, priority: 'immediate', safetyCritical: true, negotiationItem: false, photos: [] },
        ],
      },
      {
        key: 'diagnostic_scan', title: 'Diagnostic Scan', performed: 'not_performed', notPerformedReason: 'equipment_unavailable', summary: null, items: [],
      },
    ],
    generalPhotos: [],
    limitations: { standard: 'This inspection is not a warranty or a guarantee.', additional: 'Ground-level underbody only.' },
  };

  it('renders the same data the HTML report uses — key facts present', async () => {
    const bytes = await renderReportPdf(payload as never, async () => tinyJpeg(640, 480));
    const text = pdfText(bytes);
    expect(text).toContain('PPI-TEST-0001');
    expect(text).toContain('Negotiate / Repair First');
    expect(text).toContain('7.5 / 10');
    expect(text).toContain('(Seat belts \\(all positions\\)) Tj');
    expect(text).toContain('Frayed webbing');
    expect(text).toContain('$500-$900');
    expect(text).toContain('Version 2 \\(amended\\)');
    expect(text).toContain('Equipment unavailable');
    expect(text).toContain('/Filter /DCTDecode'); // embedded photo
    expect(text).toContain('not a warranty or a guarantee');
  });

  it('falls back to a caption note when photos are unavailable (R2 off)', async () => {
    const bytes = await renderReportPdf(payload as never, null);
    const text = pdfText(bytes);
    expect(text).not.toContain('/DCTDecode');
    expect(text).toContain('photo available in your online report');
  });
});
