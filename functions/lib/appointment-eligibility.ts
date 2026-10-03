import type { PpiConfig } from './config.ts';

/** Stored classifications only: names and addresses never infer eligibility. */
export interface SellerLocation {
  seller_type?: unknown;
  inspection_location_type?: unknown;
  perm_inspection?: unknown;
}

export function sundayEligible(request: SellerLocation): boolean {
  return request.seller_type === 'private'
    && request.inspection_location_type === 'private_residence'
    && Number(request.perm_inspection) === 1;
}

export function appointmentDays(config: PpiConfig, request: SellerLocation): number[] {
  const days = config.scheduling.daysOfOperation.filter((day) => day !== 0);
  return sundayEligible(request) ? [0, ...days] : days;
}

/** The same local-calendar rule is used for offers and customer selection. */
export function appointmentDateError(start: Date, config: PpiConfig, request: SellerLocation): string | null {
  if (!Number.isFinite(start.getTime())) return 'Not a valid appointment time.';
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.scheduling.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(start);
  const weekday = new Date(`${local}T12:00:00Z`).getUTCDay();
  if (weekday === 0 && !sundayEligible(request)) {
    return 'Sunday is available only for an explicitly confirmed private-sale vehicle at a private residence with inspection permission.';
  }
  if (!appointmentDays(config, request).includes(weekday)) return 'That day is outside configured operating days.';
  if (config.scheduling.blackoutDates.includes(local)) return 'That date is blacked out.';
  return null;
}
