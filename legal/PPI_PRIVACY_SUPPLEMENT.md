# Privacy Policy Supplement — Las Vegas Pre-Purchase Inspection Service

This is the factual source for the PPI-specific section of AutoClarity's
published privacy policy and the versioned PPI privacy notice. The iPhone app's
Apple/RevenueCat disclosures remain specific to the app. The physical PPI
service separately collects request and booking records and uses Stripe for
payment processing.

## PPI privacy disclosure

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
- **Limited PPI activity data** — an allowlisted event name, optional form step
  or source label, and timestamp. The activity table has no fields for your
  name, contact details, VIN, inspection address, message content, or
  payment-card details.
- **Browser storage** — while you complete the request form, your browser keeps
  the entered fields as a local draft for up to seven days; successful
  submission or the clear-draft control removes it. The customer portal keeps
  its secure-link token in that browser tab's session storage so it can return
  from Stripe Checkout.

**Service providers:** Stripe (payments), our transactional email provider
(delivery of confirmations and updates), and Cloudflare (website hosting,
database, file storage, and bot protection).

**What we don't do:** we do not sell your personal information, and we do not
send marketing messages unless you separately opted in.

**Retention:** service and payment records are retained for operating,
accounting, refund, fraud-prevention, and dispute-handling purposes. Uploaded
images are retained under the current PPI retention plan. You may request
access, correction, or deletion of your data at support@getautoclarity.com;
some records may need to be retained for an applicable business or legal
obligation.

**Security:** AutoClarity uses encrypted connections, access-controlled data
systems, and private file storage. No method of transmission or storage is
100% secure.

**Scope note:** the AutoClarity iPhone app's subscription remains an Apple App
Store purchase governed by the app's terms; the in-person inspection service is
purchased separately on this website and governed by the PPI Service Agreement.

## Terms-of-use scope

The published Terms should distinguish the products: app-specific terms govern
the iPhone app, while the in-person PPI service is governed by the exact quote
and current PPI agreements presented before payment.

## Where the agreement texts live

The nine customer-facing PPI documents (service agreement, scope & limitations,
cancellation policy, seller access, road test, photo consent, underbody
limitations, privacy notice, e-communications consent) are versioned in
`functions/lib/agreements.ts` and shown to customers in the portal at
acceptance time. Publish any content change as a new version so existing
acceptance evidence remains bound to its original document hash.
