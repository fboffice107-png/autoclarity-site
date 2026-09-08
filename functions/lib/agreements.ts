// Versioned customer agreement documents, seeded idempotently into
// agreement_versions. Published versions are immutable evidence; any content
// change must use a new version instead of rewriting an accepted document.

import { sha256Hex } from './util.ts';

export interface AgreementDoc {
  docKey: string;
  version: number;
  title: string;
  bodyMd: string;
}

interface SourceAgreementVersion extends AgreementDoc {
  id: string;
  sha256: string;
}

interface StoredAgreementVersion {
  id: string;
  doc_key: string;
  version: number;
  title: string;
  body_md: string;
  sha256: string;
}

export class AgreementIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgreementIntegrityError';
  }
}

export const AGREEMENT_DOCS: AgreementDoc[] = [
  {
    docKey: 'service_agreement',
    version: 2,
    title: 'PPI Service Agreement',
    bodyMd: `## What you are purchasing

You are purchasing a single mobile pre-purchase inspection ("PPI") of the specific vehicle identified in your request, performed in the Las Vegas, Nevada service area by an experienced automotive technician.

## What the service includes

- A comprehensive multi-point visual and operational inspection of the vehicle as described on the AutoClarity PPI page.
- A diagnostic scan only when it is included in the confirmed inspection scope, the vehicle supports it, and the seller permits it.
- A road test where the seller permits it and it is safe and lawful.
- Written findings with photographs of meaningful observations, repair priorities, estimated repair-cost ranges where appropriate, an overall condition score, and a Proceed / Negotiate–Repair First / Do Not Proceed recommendation.

## What the service is not

- The inspection is a professional opinion about the vehicle's observable condition at the time of the inspection. It is not a warranty, a guarantee, insurance, or a promise that the vehicle is free of defects.
- The final purchasing decision is always yours.

## Payment

The amount due is the exact total in the AutoClarity-approved quote shown in your portal and at Checkout. Stripe processes the payment. Your appointment is not confirmed until Stripe reports that payment was successfully completed.`,
  },
  {
    docKey: 'scope_limitations',
    version: 3,
    title: 'Scope and Limitations',
    bodyMd: `- The inspection is visual and non-invasive unless expressly stated otherwise. Components are not disassembled.
- Hidden, intermittent, or future failures may not be detectable during a single inspection.
- Seller cooperation and the inspection location can limit what is possible (road test, underbody access, diagnostic scanning, photographs).
- When a diagnostic scan is included in the confirmed scope, it reports what the vehicle's systems expose at that time; it cannot prove the absence of all faults.
- Underbody access depends on the location, seller permission, ground conditions, vehicle clearance and available equipment. If deeper access is appropriate, a suitable facility may need to be arranged in advance and separately confirmed in the quote.
- The written report reflects conditions observable at the time of inspection only.`,
  },
  {
    docKey: 'cancellation_policy',
    version: 3,
    title: 'Cancellation and Refund Policy',
    bodyMd: `- **48 hours or more before the appointment:** full refund or free rescheduling.
- **At least 24 hours but less than 48 hours:** one free reschedule.
- **Less than 24 hours:** generally nonrefundable; a transferable service credit may be offered at AutoClarity's discretion.
- **The vehicle sells before the appointment:** you may transfer the inspection to one replacement vehicle with no transfer fee. AutoClarity must review the replacement vehicle, location, requested scope and seller access and issue an updated approved quote. If the updated total is higher, you must pay the difference before the replacement booking is confirmed. If it is lower, AutoClarity refunds the difference. If it is the same, your existing payment transfers with no additional charge.
- **The seller refuses access before travel begins:** free rescheduling or one vehicle transfer with no transfer fee. A replacement vehicle is reviewed, repriced and adjusted under the replacement-vehicle terms above.
- **The seller refuses access after the technician's travel has begun:** any separately disclosed travel or mobile-service charge in the approved quote may be retained.
- **AutoClarity cancels:** full refund or priority rescheduling — your choice.

Paid cancellation and rescheduling requests are reviewed personally rather than forfeited automatically.`,
  },
  {
    docKey: 'seller_access',
    version: 2,
    title: 'Seller Access Acknowledgement',
    bodyMd: `You confirm that, to the best of your knowledge, the seller (or dealership) has agreed to allow an independent inspection of the vehicle. If diagnostic scanning is included in the confirmed inspection scope, you also confirm that the seller has agreed to reasonable diagnostic scanning. You understand that the seller controls access to the vehicle and that refused or restricted access can limit or prevent parts of the inspection.`,
  },
  {
    docKey: 'road_test',
    version: 2,
    title: 'Road-Test Authorization Acknowledgement',
    bodyMd: `A road test is performed only when the seller permits it, the vehicle appears safe to drive, and it is lawful to do so (registration/plate and location conditions). When a road test is not possible, the inspection proceeds without it and the report notes the limitation.`,
  },
  {
    docKey: 'photos_consent',
    version: 2,
    title: 'Photograph and Documentation Consent',
    bodyMd: `You consent to AutoClarity photographing the vehicle and its meaningful conditions for your report. Photographs of the vehicle are part of your report and are retained with your request records. AutoClarity does not publish your report or vehicle photographs publicly.`,
  },
  {
    docKey: 'underbody_limitations',
    version: 3,
    title: 'Underbody, Jacking and Lift Limitations',
    bodyMd: `Underbody review is performed only where it is safe, legal and physically possible at the inspection location. Not every vehicle can be lifted. Ground clearance, surface conditions, seller permission and available equipment all affect what can be observed underneath. If deeper access is appropriate, a suitable facility may need to be arranged in advance and separately confirmed in the quote.`,
  },
  {
    docKey: 'privacy_notice',
    version: 2,
    title: 'Privacy Notice for PPI Customers',
    bodyMd: `AutoClarity collects the information you provide for this inspection (your contact details, the vehicle and VIN, the inspection address, seller contact information you supply, images you upload, booking, agreement and communication records) to review, quote, schedule and perform the inspection.

- Agreement records include the accepted document versions, typed name, date and time, IP address and browser information.
- VINs are decoded through the public U.S. NHTSA vPIC service; the VIN is sent to that service for decoding.
- Payments are processed by Stripe. AutoClarity does not receive or store your full card number; it retains the approved amount, payment status and Stripe reference identifiers.
- Transactional email is delivered through our email provider.
- Data is hosted on Cloudflare infrastructure, including database, private file storage and bot protection.
- AutoClarity records limited first-party PPI activity data: an allowlisted event name, optional form step or source label, and timestamp. That activity table has no fields for your name, contact details, VIN, inspection address, message content or payment-card details.
- While you complete the request form, your browser stores a draft containing the fields you entered for up to seven days; a successful submission or the form's clear-draft control removes it. The customer portal stores its secure-link token in that browser tab's session storage so the portal can return from Stripe Checkout.
- Your personal information is not sold.
- You may request access, correction or deletion of your data at ${'support@getautoclarity.com'}; legal and accounting retention duties may require keeping some records.

The AutoClarity iPhone app's subscription remains a separate Apple/App Store product with its own terms.`,
  },
  {
    docKey: 'e_comms',
    version: 2,
    title: 'Electronic Communications Consent',
    bodyMd: `You consent to receive transactional communications about this inspection (confirmations, quotes, scheduling, results) by email and, where you chose it, by phone or text. This is required to deliver the service. Marketing communications are separate and only sent with your explicit opt-in.`,
  },
];

function sourceAgreementKey(docKey: string, version: number): string {
  return `${docKey}\u0000${version}`;
}

async function sourceAgreementVersions(): Promise<SourceAgreementVersion[]> {
  const seenDocKeys = new Set<string>();
  return Promise.all(AGREEMENT_DOCS.map(async (doc) => {
    if (!Number.isSafeInteger(doc.version) || doc.version < 1) {
      throw new AgreementIntegrityError(`Agreement ${doc.docKey} has an invalid source version.`);
    }
    if (seenDocKeys.has(doc.docKey)) {
      throw new AgreementIntegrityError(`Agreement ${doc.docKey} has multiple operative source definitions.`);
    }
    seenDocKeys.add(doc.docKey);
    return {
      ...doc,
      id: `ag_${doc.docKey}_v${doc.version}`,
      sha256: await sha256Hex(doc.bodyMd),
    };
  }));
}

async function loadSourceRows(
  db: D1Database,
  source: SourceAgreementVersion[],
): Promise<StoredAgreementVersion[]> {
  const where = source.map(() => `(doc_key = ? AND version = ?)`).join(' OR ');
  const bindings = source.flatMap((doc) => [doc.docKey, doc.version]);
  const rows = await db
    .prepare(
      `SELECT id, doc_key, version, title, body_md, sha256
       FROM agreement_versions WHERE ${where}`,
    )
    .bind(...bindings)
    .all<StoredAgreementVersion>();
  return rows.results ?? [];
}

function verifySourceRows(
  source: SourceAgreementVersion[],
  rows: StoredAgreementVersion[],
  requireAll: boolean,
): Set<string> {
  const stored = new Map(rows.map((row) => [sourceAgreementKey(row.doc_key, row.version), row]));
  for (const doc of source) {
    const key = sourceAgreementKey(doc.docKey, doc.version);
    const row = stored.get(key);
    if (!row) {
      if (requireAll) {
        throw new AgreementIntegrityError(`Agreement ${doc.docKey} v${doc.version} could not be seeded.`);
      }
      continue;
    }
    if (
      row.id !== doc.id
      || row.title !== doc.title
      || row.body_md !== doc.bodyMd
      || row.sha256 !== doc.sha256
    ) {
      throw new AgreementIntegrityError(
        `Agreement ${doc.docKey} v${doc.version} differs from its immutable source definition.`,
      );
    }
  }
  return new Set(stored.keys());
}

/**
 * Idempotently seed every source agreement version. Existing versions must
 * match source byte-for-byte; content changes require a new explicit version.
 */
async function ensureSourceAgreements(
  db: D1Database,
  source: SourceAgreementVersion[],
): Promise<void> {
  const existing = await loadSourceRows(db, source);
  const existingKeys = verifySourceRows(source, existing, false);
  const missing = source.filter((doc) => !existingKeys.has(sourceAgreementKey(doc.docKey, doc.version)));
  if (missing.length === 0) return;

  const now = new Date().toISOString();
  await db.batch(
    missing.map((doc) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(doc.id, doc.docKey, doc.version, doc.title, doc.bodyMd, doc.sha256, now),
    ),
  );

  // INSERT OR IGNORE makes concurrent seeders safe. Re-read every source tuple
  // so an id/version collision or concurrently inserted mismatch fails closed.
  verifySourceRows(source, await loadSourceRows(db, source), true);
}

export async function ensureAgreements(db: D1Database): Promise<void> {
  await ensureSourceAgreements(db, await sourceAgreementVersions());
}

/** Latest version of every agreement document. */
export async function latestAgreements(db: D1Database): Promise<
  Array<{ id: string; doc_key: string; version: number; title: string; body_md: string; sha256: string }>
> {
  const source = await sourceAgreementVersions();
  await ensureSourceAgreements(db, source);
  const rows = await db
    .prepare(
      `SELECT av.id, av.doc_key, av.version, av.title, av.body_md, av.sha256
       FROM agreement_versions av
       JOIN (SELECT doc_key, MAX(version) AS v FROM agreement_versions GROUP BY doc_key) latest
         ON latest.doc_key = av.doc_key AND latest.v = av.version
       ORDER BY av.doc_key`,
    )
    .all<StoredAgreementVersion>();
  const latest = rows.results ?? [];
  const sourceByDocKey = new Map(source.map((doc) => [doc.docKey, doc]));
  if (latest.length !== sourceByDocKey.size) {
    throw new AgreementIntegrityError(
      `Operative agreement set has ${latest.length} documents; source requires ${sourceByDocKey.size}.`,
    );
  }
  for (const row of latest) {
    const doc = sourceByDocKey.get(row.doc_key);
    if (
      !doc
      || row.id !== doc.id
      || row.version !== doc.version
      || row.title !== doc.title
      || row.body_md !== doc.bodyMd
      || row.sha256 !== doc.sha256
    ) {
      throw new AgreementIntegrityError(
        `Operative agreement ${row.doc_key} v${row.version} has no exact source definition.`,
      );
    }
  }
  return latest;
}
