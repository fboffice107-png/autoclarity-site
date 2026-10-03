-- Additive only. No inferred classifications, discovery backfills, or changes
-- to scheduling configuration, prices, agreements, slots, or paid bookings.
ALTER TABLE ppi_requests ADD COLUMN inspection_location_type TEXT
  CHECK (inspection_location_type IN ('private_residence', 'other', 'unknown'));
ALTER TABLE ppi_requests ADD COLUMN dealership_name TEXT;
ALTER TABLE ppi_requests ADD COLUMN discovery_source TEXT
  CHECK (discovery_source IN ('google_search', 'google_maps', 'instagram', 'tiktok',
    'facebook', 'youtube', 'friend_family', 'dealership', 'other', 'dont_remember'));
ALTER TABLE ppi_requests ADD COLUMN discovery_detail TEXT;
