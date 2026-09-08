-- Persist one privacy-minimized, allowlisted first-touch acquisition category
-- on each request so server-authoritative payments and completions can be
-- grouped without storing raw URLs, hosts, UTM values, campaigns, terms, or
-- referrer paths. Existing requests and unrecognized input stay unknown.

ALTER TABLE ppi_requests ADD COLUMN attribution_source TEXT NOT NULL DEFAULT 'ppi_unknown'
  CHECK (attribution_source IN (
    'ppi_unknown',
    'ppi_direct',
    'ppi_internal',
    'ppi_search_organic',
    'ppi_social_social',
    'ppi_directory_referral',
    'ppi_referral_referral',
    'ppi_google_cpc',
    'ppi_google_organic',
    'ppi_bing_cpc',
    'ppi_bing_organic',
    'ppi_yahoo_organic',
    'ppi_duckduckgo_organic',
    'ppi_facebook_social',
    'ppi_facebook_paid_social',
    'ppi_instagram_social',
    'ppi_instagram_paid_social',
    'ppi_tiktok_social',
    'ppi_tiktok_paid_social',
    'ppi_youtube_social',
    'ppi_youtube_paid_social',
    'ppi_reddit_social',
    'ppi_reddit_paid_social',
    'ppi_nextdoor_referral',
    'ppi_yelp_referral',
    'ppi_apple_referral',
    'ppi_email_email',
    'ppi_campaign_cpc',
    'ppi_campaign_organic',
    'ppi_campaign_social',
    'ppi_campaign_paid_social',
    'ppi_campaign_email',
    'ppi_campaign_referral',
    'ppi_campaign_display',
    'ppi_google_business_profile',
    'ppi_bing_places',
    'ppi_apple_maps',
    'ppi_chatgpt_search',
    'ppi_perplexity_search',
    'ppi_claude_search'
  ));

CREATE INDEX IF NOT EXISTS idx_requests_attribution_source
  ON ppi_requests(attribution_source);
