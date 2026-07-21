// Server-side validation for the public intake form. Client-side validation
// exists for usability only — this is the enforcement layer.

import { clampStr } from './util.ts';

export interface FieldErrors {
  [field: string]: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ZIP_RE = /^\d{5}$/;

export function validEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

export function normalizePhone(v: string): string | null {
  const digits = v.replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return null;
}

export function validUrl(v: string): boolean {
  if (v.length > 2000) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

export function intInRange(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export interface IntakePayload {
  // buyer
  fullName: string;
  email: string;
  phone: string;
  preferredContact: 'email' | 'phone' | 'text';
  transactionalConsent: boolean;
  marketingConsent: boolean;
  // vehicle
  year: number | null;
  make: string;
  model: string;
  trim: string;
  mileage: number | null;
  vin: string;
  askingPrice: string;
  expectedPrice: string;
  listingUrl: string;
  modStatus: 'stock' | 'light' | 'heavy';
  warningLights: string;
  knownIssues: string;
  titleStatus: 'clean' | 'salvage_rebuilt' | 'unknown';
  startsDrives: 'yes' | 'no' | 'unknown';
  // location
  locStreet: string;
  locUnit: string;
  locCity: string;
  locState: string;
  locZip: string;
  sellerType: 'dealership' | 'private' | 'unknown';
  sellerName: string;
  sellerPhone: string;
  locNotes: string;
  accessNotes: string;
  liftAvailable: 'yes' | 'no' | 'unknown';
  levelSurface: 'yes' | 'no' | 'unknown';
  // permission
  permInspection: boolean;
  permScan: boolean;
  permRoadTest: 'yes' | 'no' | 'unknown';
  permPhotos: 'yes' | 'no' | 'unknown';
  permUnderbody: 'yes' | 'no' | 'unknown';
  ackAccessDependent: boolean;
  // timing
  decisionTimeline: string;
  preferredDates: string;
  timeWindow: 'morning' | 'afternoon' | 'flexible';
  sameDayPriority: boolean;
  customerNotes: string;
}

export function parseIntake(raw: Record<string, unknown>): { payload: IntakePayload; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const s = (k: string, max: number) => clampStr(raw[k], max);
  const b = (k: string) => raw[k] === true || raw[k] === 'true' || raw[k] === 'on' || raw[k] === '1';

  const payload: IntakePayload = {
    fullName: s('fullName', 120),
    email: s('email', 254).toLowerCase(),
    phone: s('phone', 30),
    preferredContact: oneOf(raw['preferredContact'], ['email', 'phone', 'text'] as const, 'email'),
    transactionalConsent: b('transactionalConsent'),
    marketingConsent: b('marketingConsent'),
    year: intInRange(raw['year'], 1920, new Date().getFullYear() + 2),
    make: s('make', 60),
    model: s('model', 80),
    trim: s('trim', 80),
    mileage: intInRange(raw['mileage'], 0, 1_500_000),
    vin: s('vin', 25),
    askingPrice: s('askingPrice', 20),
    expectedPrice: s('expectedPrice', 20),
    listingUrl: s('listingUrl', 2000),
    modStatus: oneOf(raw['modStatus'], ['stock', 'light', 'heavy'] as const, 'stock'),
    warningLights: s('warningLights', 500),
    knownIssues: s('knownIssues', 2000),
    titleStatus: oneOf(raw['titleStatus'], ['clean', 'salvage_rebuilt', 'unknown'] as const, 'unknown'),
    startsDrives: oneOf(raw['startsDrives'], ['yes', 'no', 'unknown'] as const, 'unknown'),
    locStreet: s('locStreet', 200),
    locUnit: s('locUnit', 100),
    locCity: s('locCity', 80),
    locState: s('locState', 2).toUpperCase(),
    locZip: s('locZip', 10),
    sellerType: oneOf(raw['sellerType'], ['dealership', 'private', 'unknown'] as const, 'unknown'),
    sellerName: s('sellerName', 120),
    sellerPhone: s('sellerPhone', 30),
    locNotes: s('locNotes', 1000),
    accessNotes: s('accessNotes', 1000),
    liftAvailable: oneOf(raw['liftAvailable'], ['yes', 'no', 'unknown'] as const, 'unknown'),
    levelSurface: oneOf(raw['levelSurface'], ['yes', 'no', 'unknown'] as const, 'unknown'),
    permInspection: b('permInspection'),
    permScan: b('permScan'),
    permRoadTest: oneOf(raw['permRoadTest'], ['yes', 'no', 'unknown'] as const, 'unknown'),
    permPhotos: oneOf(raw['permPhotos'], ['yes', 'no', 'unknown'] as const, 'unknown'),
    permUnderbody: oneOf(raw['permUnderbody'], ['yes', 'no', 'unknown'] as const, 'unknown'),
    ackAccessDependent: b('ackAccessDependent'),
    decisionTimeline: s('decisionTimeline', 120),
    preferredDates: s('preferredDates', 300),
    timeWindow: oneOf(raw['timeWindow'], ['morning', 'afternoon', 'flexible'] as const, 'flexible'),
    sameDayPriority: b('sameDayPriority'),
    customerNotes: s('customerNotes', 2000),
  };

  if (payload.fullName.length < 2) errors['fullName'] = 'Please enter your full name.';
  if (!validEmail(payload.email)) errors['email'] = 'Please enter a valid email address.';
  if (!normalizePhone(payload.phone)) errors['phone'] = 'Please enter a valid US mobile number.';
  if (!payload.transactionalConsent) {
    errors['transactionalConsent'] = 'We need permission to contact you about this inspection request.';
  }
  if (!payload.make) errors['make'] = 'Vehicle make is required.';
  if (!payload.model) errors['model'] = 'Vehicle model is required.';
  if (payload.year === null) errors['year'] = 'Please enter a valid model year.';
  if (payload.listingUrl && !validUrl(payload.listingUrl)) errors['listingUrl'] = 'Listing link must be a valid http(s) URL.';
  if (!payload.locCity) errors['locCity'] = 'City is required.';
  if (!ZIP_RE.test(payload.locZip)) errors['locZip'] = 'Please enter a 5-digit ZIP code.';
  if (payload.locState && payload.locState.length !== 2) errors['locState'] = 'Use the 2-letter state code.';
  if (!payload.ackAccessDependent) {
    errors['ackAccessDependent'] = 'Please acknowledge that inspection access depends on the seller and location.';
  }

  return { payload, errors };
}
