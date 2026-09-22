// Real customer, or test record?
//
// Both live in the same table on purpose — the seeded fixtures and smoke tests
// document real refund, dispute and delivery rehearsals and are worth keeping.
// But a dashboard that shows them alongside paying customers cannot be read at
// a glance, and a scoreboard that counts them is lying about the business.
//
// The stored `record_kind` column is the authority. This module only decides
// what a BRAND NEW record should start as, and the rule is deliberately
// conservative: a request is 'real' unless it is positively identified as a
// test. Getting that backwards would hide a paying customer.

export type RecordKind = 'real' | 'test';

/**
 * RFC 2606 / RFC 6761 reserved domains. These can never receive mail, so no
 * real customer could ever have been contacted at one.
 */
const RESERVED_EMAIL_DOMAINS = [
  '@example.com', '@example.invalid', '@example.org', '@example.net',
  '@test.invalid', '@invalid', '@localhost',
];

/** Reference prefixes used by the fixture seeder and the smoke-test scripts. */
const RESERVED_REF_PREFIXES = ['PPI-FIXTURE', 'PPI-INTERNAL'];

/**
 * Words someone writes in the name field to say what a record was for.
 *
 * Matched as WHOLE WORDS, never as substrings. "Testa" is a real surname and
 * "Protestina" is a real given name; filing either as a test record would hide
 * a paying customer from the only dashboard the owner reads.
 */
const TEST_NAME_MARKERS = new Set([
  'TEST', 'TESTS', 'TESTER', 'TESTING', 'FIXTURE', 'FIXTURES', 'SMOKE',
  'SANDBOX', 'VERIFICATION', 'VERIFIER', 'DELETED', 'PLACEHOLDER', 'DUMMY',
]);

/** Split a name into comparable words, treating punctuation as a separator. */
function nameWords(name: string): string[] {
  return name.toUpperCase().split(/[^A-Z0-9]+/u).filter(Boolean);
}

export interface RecordKindInput {
  ref?: string | null;
  email?: string | null;
  fullName?: string | null;
}

/**
 * Why this record looks like a test, or null if it looks like real business.
 * The reason is shown to the owner so the classification is never a black box.
 */
export function testRecordReason(input: RecordKindInput): string | null {
  const ref = (input.ref ?? '').toUpperCase();
  for (const prefix of RESERVED_REF_PREFIXES) {
    if (ref.startsWith(prefix)) return `reference starts with ${prefix}`;
  }
  const email = (input.email ?? '').toLowerCase();
  for (const domain of RESERVED_EMAIL_DOMAINS) {
    if (email.endsWith(domain)) return `${domain} is a reserved address that cannot receive mail`;
  }
  for (const word of nameWords(input.fullName ?? '')) {
    if (TEST_NAME_MARKERS.has(word)) return `the name contains the word “${word}”`;
  }
  return null;
}

/** What a newly created record should start as. Real unless proven a test. */
export function initialRecordKind(input: RecordKindInput): RecordKind {
  return testRecordReason(input) === null ? 'real' : 'test';
}

export function isRecordKind(value: unknown): value is RecordKind {
  return value === 'real' || value === 'test';
}

/**
 * SQL predicate limiting a query to genuine business. Written out rather than
 * derived, so the business numbers depend on the owner's stored decision and
 * never on a heuristic re-run at read time.
 */
export const REAL_RECORDS_ONLY = `record_kind = 'real'`;
