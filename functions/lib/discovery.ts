import { clampStr, nowIso } from './util.ts';

/** Customer-reported answers, deliberately separate from analytics attribution. */
export const DISCOVERY_OPTIONS = [
  { value: 'google_search', label: 'Google Search' },
  { value: 'google_maps', label: 'Google Maps' },
  { value: 'instagram', label: 'Instagram video or post', detail: 'social' },
  { value: 'tiktok', label: 'TikTok video', detail: 'social' },
  { value: 'facebook', label: 'Facebook video or post', detail: 'social' },
  { value: 'youtube', label: 'YouTube video', detail: 'social' },
  { value: 'friend_family', label: 'Friend or family recommendation' },
  { value: 'dealership', label: 'Dealership recommendation' },
  { value: 'other', label: 'Other', detail: 'other' },
  { value: 'dont_remember', label: 'I don’t remember' },
] as const;

export function discoveryLabel(value: unknown): string {
  return DISCOVERY_OPTIONS.find((option) => option.value === value)?.label ?? '';
}

export function parseDiscovery(source: unknown, detail: unknown): { source: string | null; detail: string | null } {
  const option = DISCOVERY_OPTIONS.find((candidate) => candidate.value === source);
  // Optional inputs must never become a gate to booking. Invalid categories
  // are discarded, and detail cannot create an answer by itself.
  if (!option) return { source: null, detail: null };
  const text = 'detail' in option ? clampStr(detail, 500).replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  return { source: option.value, detail: text || null };
}

export async function saveMissingDiscovery(db: D1Database, requestId: string, source: unknown, detail: unknown): Promise<void> {
  const answer = parseDiscovery(source, detail);
  if (!answer.source) return;
  // First answer wins even for stale tabs and concurrent approval submissions.
  await db.prepare(`UPDATE ppi_requests SET discovery_source = ?, discovery_detail = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL AND (discovery_source IS NULL OR discovery_source = '')`)
    .bind(answer.source, answer.detail, nowIso(), requestId).run();
}
