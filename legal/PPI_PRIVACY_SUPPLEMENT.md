# Privacy Policy Supplement — Las Vegas Pre-Purchase Inspection Service

> **LEGAL REVIEW REQUIRED BEFORE LIVE MODE** — owner-review draft. This
> supplements the existing AutoClarity privacy policy (privacy.html), which
> currently describes only the iPhone app. Publish the combined/updated policy
> before accepting live PPI customers. Not legal advice.

**Why this is needed:** the current site policy describes an app whose payments
run through Apple and which stores no service records. The PPI service is
different: it collects booking data and payments run through **Stripe** — the
policy must say so. The app's Apple/RevenueCat subscription language stays true
for the app, but can no longer be presented as covering everything AutoClarity
does. Likewise, the in-person inspection creates a real service relationship
governed by the PPI Service Agreement — the app's "informational guidance only"
framing applies to the app, not to the physical inspection.

## Draft section to add to the published privacy policy

### The Las Vegas Pre-Purchase Inspection service

When you request an in-person pre-purchase inspection, AutoClarity collects and
uses the following information to review, quote, schedule and perform your
inspection:

- **Your contact details** — name, email address, phone number, and contact
  preference.
- **Vehicle information** — year, make, model, trim, mileage, VIN, asking and
  expected prices, listing link, and condition details you provide. VINs are
  decoded using the public U.S. NHTSA vPIC service; only the VIN itself is sent
  to it.
- **The inspection location** and seller contact information you supply.
- **Images you upload** (listing screenshots, VIN plate, dashboard, damage
  photos). These are stored privately and are never made public.
- **Booking, agreement, and communication records** — quotes, appointment
  times, the agreements you accepted (including the document version, your
  typed name, the date and time, and the IP address and browser information at
  acceptance), and messages exchanged about your request.
- **Payment status** — payments for inspections are processed by **Stripe**.
  AutoClarity never receives or stores your full card number. We keep the
  payment amount, its status, and Stripe's reference identifiers.

**Service providers:** Stripe (payments), our transactional email provider
(delivery of confirmations and updates), and Cloudflare (website hosting,
database, file storage, and bot protection).

**What we don't do:** we do not sell your personal information, and we do not
send marketing messages unless you separately opted in.

**Retention:** service and payment records are retained as required for legal,
tax, and dispute purposes; uploaded images are kept only as long as useful for
your inspection. You may request access, correction, or deletion of your data
at support@getautoclarity.com; we will honor requests except where retention is
legally required.

**Security:** we use industry-standard safeguards (encrypted connections,
access-controlled storage, private file storage). No method of transmission or
storage is 100% secure.

**Scope note:** the AutoClarity iPhone app's subscription remains an Apple App
Store purchase governed by the app's terms; the in-person inspection service is
purchased separately on this website and governed by the PPI Service Agreement.

## Terms-of-use touchpoint (flag for the same review)

`terms.html` should gain one clarifying line: app terms govern the app; the
in-person PPI service is governed by the PPI Service Agreement presented at
booking. Do not state that AutoClarity provides "information only" in a way
that would contradict selling a physical inspection.

## Where the agreement texts live

The nine customer-facing PPI documents (service agreement, scope & limitations,
cancellation policy, seller access, road test, photo consent, underbody
limitations, privacy notice, e-communications consent) are versioned in
`functions/lib/agreements.ts` and shown to customers in the portal at
acceptance time. Counsel edits should be applied there (bump the version), so
acceptances always bind to an exact document hash.
