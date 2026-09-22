-- 0015 — an offered time is an invitation, not a reservation.
--
-- 0014 let several 'offered' rows on the SAME request share a buffer window,
-- so three alternatives could go out together. That is still too narrow for how
-- the business actually runs: the owner wants to hand a customer a wide slate
-- (say hourly, 10:00-17:00, across several days) and let them pick, and wants
-- to hand the same slate to the next customer without the first one's untaken
-- options blocking it.
--
-- The rule becomes: only 'held' and 'confirmed' rows reserve capacity, and they
-- reserve it against each other absolutely, on every request. An 'offered' row
-- reserves nothing.
--
-- The money-critical guarantee is untouched and still enforced by the database:
--   * these triggers refuse any held/confirmed window that overlaps another
--     held/confirmed window, including travel and report buffers;
--   * the partial unique index from 0001 refuses two held/confirmed rows at the
--     same start instant.
-- Two customers therefore still cannot both hold or both confirm overlapping
-- windows. What changes is only what happens BEFORE anyone commits: several
-- customers may be looking at the same free window, and the first to hold it
-- takes it. The portal already answers a lost race with "that time was just
-- taken — please pick another window".
--
-- Offering a time that is already held or confirmed remains blocked, but by the
-- application preflight (functions/lib/booking-proposal.ts) rather than by a
-- trigger, so the owner gets a sentence naming the clash instead of a database
-- error — and so a genuinely free window is never refused.

DROP TRIGGER IF EXISTS appointment_slots_no_overlap_insert;
DROP TRIGGER IF EXISTS appointment_slots_no_overlap_update;

CREATE TRIGGER appointment_slots_no_overlap_insert
BEFORE INSERT ON appointment_slots
WHEN NEW.status IN ('held', 'confirmed')
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM appointment_slots existing
    WHERE existing.status IN ('held', 'confirmed')
      AND COALESCE(existing.blocked_starts_at, existing.starts_at) < COALESCE(NEW.blocked_ends_at, NEW.ends_at)
      AND COALESCE(existing.blocked_ends_at, existing.ends_at) > COALESCE(NEW.blocked_starts_at, NEW.starts_at)
  ) THEN RAISE(ABORT, 'appointment slot overlaps an active window') END);
END;

CREATE TRIGGER appointment_slots_no_overlap_update
BEFORE UPDATE OF starts_at, ends_at, blocked_starts_at, blocked_ends_at, status ON appointment_slots
WHEN NEW.status IN ('held', 'confirmed')
BEGIN
  SELECT (CASE WHEN EXISTS (
    SELECT 1
    FROM appointment_slots existing
    WHERE existing.id != NEW.id
      AND existing.status IN ('held', 'confirmed')
      AND COALESCE(existing.blocked_starts_at, existing.starts_at) < COALESCE(NEW.blocked_ends_at, NEW.ends_at)
      AND COALESCE(existing.blocked_ends_at, existing.ends_at) > COALESCE(NEW.blocked_starts_at, NEW.starts_at)
  ) THEN RAISE(ABORT, 'appointment slot overlaps an active window') END);
END;
