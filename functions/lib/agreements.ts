// Owner-review DRAFT agreement documents, seeded idempotently into
// agreement_versions. Every document is explicitly labeled as requiring legal
// review before live mode. Do not present these as attorney-approved terms.

import { sha256Hex } from './util.ts';

export interface AgreementDoc {
  docKey: string;
  title: string;
  bodyMd: string;
}

const REVIEW_BANNER = `> **LEGAL REVIEW REQUIRED BEFORE LIVE MODE** — This document is an owner-review draft prepared for AutoClarity. It is not legal advice and must be reviewed by a Nevada-licensed attorney before any live customer transaction.`;

export const AGREEMENT_DOCS: AgreementDoc[] = [
  {
    docKey: 'service_agreement',
    title: 'PPI Service Agreement',
    bodyMd: `${REVIEW_BANNER}

## What you are purchasing

You are purchasing a single mobile pre-purchase inspection ("PPI") of the specific vehicle identified in your request, performed in the Las Vegas, Nevada service area by an experienced automotive technician.

## What the service includes

- A comprehensive multi-point visual and operational inspection of the vehicle as described on the AutoClarity PPI page.
- A diagnostic scan where the vehicle supports it and the seller permits it.
- A road test where the seller permits it and it is safe and lawful.
- Written findings with photographs of meaningful observations, repair priorities, estimated repair-cost ranges where appropriate, an overall condition score, and a Proceed / Negotiate–Repair First / Do Not Proceed recommendation.

## What the service is not

- The inspection is a professional opinion about the vehicle's observable condition at the time of the inspection. It is not a warranty, a guarantee, insurance, or a promise that the vehicle is free of defects.
- The final purchasing decision is always yours.

## Payment

Full payment through our secure payment processor reserves the approved appointment time. Your appointment is not confirmed until payment is successfully completed.`,
  },
  {
    docKey: 'scope_limitations',
    title: 'Scope and Limitations',
    bodyMd: `${REVIEW_BANNER}

- The inspection is visual and non-invasive unless expressly stated otherwise. Components are not disassembled.
- Hidden, intermittent, or future failures may not be detectable during a single inspection.
- Seller cooperation and the inspection location can limit what is possible (road test, underbody access, diagnostic scanning, photographs).
- A diagnostic scan reports what the vehicle's systems expose at that time; it cannot prove the absence of all faults.
- Underbody access depends on the location, seller permission, ground conditions, vehicle clearance and available equipment. A full lift inspection may require a partner facility and an additional charge.
- The written report reflects conditions observable at the time of inspection only.`,
  },
  {
    docKey: 'cancellation_policy',
    title: 'Cancellation and Refund Policy',
    bodyMd: `${REVIEW_BANNER}

- **More than 48 hours before the appointment:** full refund or free rescheduling.
- **Between 24 and 48 hours:** one free reschedule.
- **Less than 24 hours:** generally nonrefundable; a transferable service credit may be offered at AutoClarity's discretion.
- **The vehicle sells before the appointment:** one free transfer to a different vehicle.
- **The seller refuses access before travel begins:** free reschedule or vehicle transfer.
- **The seller refuses access after the technician's travel has begun:** the mobile-service/dispatch portion may be retained.
- **AutoClarity cancels:** full refund or priority rescheduling — your choice.

Unusual situations are reviewed personally rather than enforced automatically.`,
  },
  {
    docKey: 'seller_access',
    title: 'Seller Access Acknowledgement',
    bodyMd: `${REVIEW_BANNER}

You confirm that, to the best of your knowledge, the seller (or dealership) has agreed to allow an independent inspection of the vehicle, including reasonable diagnostic scanning. You understand that the seller controls access to the vehicle and that refused or restricted access can limit or prevent parts of the inspection.`,
  },
  {
    docKey: 'road_test',
    title: 'Road-Test Authorization Acknowledgement',
    bodyMd: `${REVIEW_BANNER}

A road test is performed only when the seller permits it, the vehicle appears safe to drive, and it is lawful to do so (registration/plate and location conditions). When a road test is not possible, the inspection proceeds without it and the report notes the limitation.`,
  },
  {
    docKey: 'photos_consent',
    title: 'Photograph and Documentation Consent',
    bodyMd: `${REVIEW_BANNER}

You consent to AutoClarity photographing the vehicle and its meaningful conditions for your report. Photographs of the vehicle are part of your report and are retained with your request records. AutoClarity does not publish your report or vehicle photographs publicly.`,
  },
  {
    docKey: 'underbody_limitations',
    title: 'Underbody, Jacking and Lift Limitations',
    bodyMd: `${REVIEW_BANNER}

Underbody review is performed only where it is safe, legal and physically possible at the inspection location. Not every vehicle can be lifted. Ground clearance, surface conditions, seller permission and available equipment all affect what can be observed underneath. A full lift inspection may require a partner facility and an additional charge quoted in advance.`,
  },
  {
    docKey: 'privacy_notice',
    title: 'Privacy Notice for PPI Customers',
    bodyMd: `${REVIEW_BANNER}

AutoClarity collects the information you provide for this inspection (your contact details, the vehicle and VIN, the inspection address, seller contact information you supply, images you upload, booking and agreement records) to review, quote, schedule and perform the inspection.

- Payments are processed by Stripe; AutoClarity never sees or stores your full card number.
- Transactional email is delivered through our email provider.
- Data is hosted on Cloudflare infrastructure (database and private file storage).
- Your personal information is not sold.
- You may request access, correction or deletion of your data at ${'support@getautoclarity.com'}; legal and accounting retention duties may require keeping some records.

The AutoClarity iPhone app's subscription remains a separate Apple/App Store product with its own terms.`,
  },
  {
    docKey: 'e_comms',
    title: 'Electronic Communications Consent',
    bodyMd: `${REVIEW_BANNER}

You consent to receive transactional communications about this inspection (confirmations, quotes, scheduling, results) by email and, where you chose it, by phone or text. This is required to deliver the service. Marketing communications are separate and only sent with your explicit opt-in.`,
  },
];

/** Idempotently seed version 1 of every agreement document. */
export async function ensureAgreements(db: D1Database): Promise<void> {
  const existing = await db.prepare(`SELECT COUNT(*) AS n FROM agreement_versions`).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return;
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const doc of AGREEMENT_DOCS) {
    const hash = await sha256Hex(doc.bodyMd);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO agreement_versions (id, doc_key, version, title, body_md, sha256, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
        )
        .bind(`ag_${doc.docKey}_v1`, doc.docKey, doc.title, doc.bodyMd, hash, now),
    );
  }
  await db.batch(stmts);
}

/** Latest version of every agreement document. */
export async function latestAgreements(db: D1Database): Promise<
  Array<{ id: string; doc_key: string; version: number; title: string; body_md: string; sha256: string }>
> {
  await ensureAgreements(db);
  const rows = await db
    .prepare(
      `SELECT av.id, av.doc_key, av.version, av.title, av.body_md, av.sha256
       FROM agreement_versions av
       JOIN (SELECT doc_key, MAX(version) AS v FROM agreement_versions GROUP BY doc_key) latest
         ON latest.doc_key = av.doc_key AND latest.v = av.version
       ORDER BY av.doc_key`,
    )
    .all<{ id: string; doc_key: string; version: number; title: string; body_md: string; sha256: string }>();
  return rows.results ?? [];
}
