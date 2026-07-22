# Founder Photo — Source & Provenance

## What was used

The founder hero/portrait images are extracted from the owner's approved
AutoClarity App Store marketing screenshot — the real photograph of **Faheb
Brown** in his gray "FAHEB" technician uniform.

- **Source file found:** `AutoClarityContentFactory/01_built_by_a_real_mechanic_2.png`
  (in the AutoClarity workspace at `/Volumes/Super Storage/`).
- **Source dimensions:** 1284 × 2778 (full App Store screenshot).
- **Status:** **EXTRACTED, not the original.** This is the highest-quality copy
  of this exact photograph that could be located locally. It is a real
  photograph of the owner — not AI-generated.

The owner's message referenced `/mnt/data/01_built_by_a_real_mechanic_2(1).png`;
that path is not present on this machine, but the identically-named source
(`01_built_by_a_real_mechanic_2.png`) is the same approved image and was used.

## Higher-resolution original — searched, not found

Searched: repo `assets/`, the AutoClarity workspace root, `AutoClarityContentFactory/`
(ads, FINISHED/, WORKING/), reference shots, CTA images, and marketing exports.
Findings:

- The two "mobile reference shot" files are app-UI mockups (941×1672), not the
  founder portrait.
- Several CTA images exist, but at least one (`nano banna 2 pro autoclarity cta.png`)
  is **AI-generated** (Gemini "nano banana") and was deliberately **not used** —
  the requirement is the real photograph, unaltered.
- No standalone, higher-resolution original of this exact photograph (e.g. the
  camera original or a design source PSD) was found locally.

**Recommended replacement action:** if the owner can provide the original camera
file (or the design source containing this photo), drop it in and re-run
`scripts/build-founder-photo.py` (documented below) to regenerate crisper assets.
Until then, the extracted crop is displayed at a size that keeps it sharp.

## Extraction

- Cropped **only** the interior of the blue rounded portrait frame — no "Built
  by a real mechanic" text, no headline, no No-tools/Plain-English/PDF-report
  badges, no AutoClarity logo, no phone-frame graphics.
- Extracted region (source px): approximately x 226–1060, y 746–1795.
- Result: **834 × 1049** (≈ 4:5 portrait), head-and-shoulders with natural
  headroom, full FAHEB uniform and name patch visible, friendly expression
  preserved.
- Conservative processing only: a mild unsharp mask to counter screenshot
  softness. **No cropping of facial identity, no generative modification, no
  skin-tone alteration.**
- **EXIF/GPS:** none present in source; outputs carry no metadata (verified with
  `exiftool`).

## Generated assets (`assets/img/`)

| File | Purpose |
|---|---|
| `faheb-founder-original.png` | Lossless 834×1049 extraction (archival / re-encode source) |
| `faheb-founder-834.{avif,webp,jpg}` | Full-size (desktop hero at ~1.5–1.7× density) |
| `faheb-founder-640.{avif,webp,jpg}` | Mid (tablet / large phone) |
| `faheb-founder-460.{avif,webp,jpg}` | Small (mobile hero, Meet-Your-Inspector crop) |

AVIF ≈ 28–50 KB, WebP ≈ 34–67 KB, JPEG ≈ 53–124 KB across sizes. Served via a
`<picture>` with `srcset`, explicit width/height (no layout shift), eager load +
high fetch priority for the above-the-fold hero.

## Quality limitation (documented per instruction)

Because the source is an App Store screenshot, the native extraction is 834 px
wide. It is intentionally **not upscaled to 1200 px** (that would be visibly
soft). The hero is therefore sized so the 834 px asset stays crisp; the
Meet-Your-Inspector section uses the smaller 460 px crop. Replace with a true
high-resolution original when available for a larger, sharper hero.

## Alt text & caption used

- Alt: "Faheb Brown, founder and lead technician of AutoClarity"
- Caption: "Faheb Brown — Founder & Lead Technician — 11+ years of hands-on
  automotive experience"

## Regenerating

`scripts/build-founder-photo.py` reproduces every output from the source PNG
(or a replacement original) — crop, mild sharpen, strip metadata, and encode all
sizes/formats.
