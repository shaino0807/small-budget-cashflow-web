# Journal redesign QA

Date: 2026-09-11 (Asia/Taipei)

final result: targeted corrections verified locally; earlier broad pass was incomplete

Scope: local visual implementation and core local interactions. This is not a production release or real LINE acceptance result.

## Source and comparison evidence

- User selection: concept 2 (warm editorial journal), with concept 3 numerical bars and transaction detail.
- Combined source: `C:/Users/shaino/.codex/generated_images/01a089f8-65a1-7731-96f6-549e9c388bf9/exec-8bf3e8eb-5e36-41f7-b435-71636c523fb6.png`.
- Actual application: http://127.0.0.1:5198/ .
- Side-by-side comparison: http://127.0.0.1:5198/reports/journal-comparison.html . Source image and rendered application DOM were captured together, not judged from separate image views.
- Comparison normalization: 1440 × 1040 CSS viewport; source displayed at 712 px wide; actual 1440 CSS px layout scaled to 0.495 beside it. Browser screenshots were emitted inline in the task; no screenshot PNG export is claimed. Source is a visual concept, not an exact production state.
- Additional unscaled checks: desktop 1440 × 1024 and mobile 390 × 844. Focused financial-table and summary captures supplement the overview comparison.
- Synthetic dashboard: `/reports/journal-dashboard-fixture.html`, and `?negative` for zero income / expense 230. These ignored local fixtures are not release files and contain no customer records.

## Findings and verified fixes

1. P2: Pale text inherited from the former dark solution panel was unreadable on ivory. Changed paragraph/eyebrow colors to the warm neutral palette.
2. P2: Mobile introductory content pushed form fields too far down. Compacted the aside and step layout while retaining instructions and progress.
3. P2: Initial desktop invitation and financial typography was too small compared with the concept. Increased heading, body and amount sizes, then repeated the combined comparison.
4. P2: Global table minimum width forced the mobile ledger to 680 px. Added `.journal-ledger { min-width: 0; }`. Final browser readback: table width 335, container width 335, scroll width 335 at 390 px viewport. Screenshot confirms date, merchant, type and signed amount visible together.
5. Compatibility: updated the existing smoke assertion to read amount cells after entries became table rows. The numerical assertion remains intact.

The initial review missed the consent error state, contact cards and source-date cards. The user's screenshots invalidated the earlier broad pass; the focused revalidation below supersedes that conclusion.

## User-reported defects: correction and revalidation

- Step 6 overlap: removed absolute positioning from the consent step so its full height participates in layout. The error summary follows the buttons with a 24 px gap. At 390 and 1024 px widths, the error is visible without overlapping the form or causing page overflow. Checking consent clears the existing error immediately; no report submission is needed to clear it.
- Contact text: the former dark-panel white text rule overrode the ivory theme. Explicit dark title/body colors and full opacity now apply to all four cards, including disabled links. Disabled links retain their disabled behavior and a dashed border. At 390 px, all four cards have client/scroll width 333/333; desktop 1024 px also has no card overflow.
- Source-date cards: removed fixed minimum column widths, split dates and evidence onto their own rows, and allowed wrapping. Source/status labels are readable Chinese; `current` is translated as an update-time check, not a claim of today's freshness. At 1024 px each card measures 351/351 px client/scroll width; at 390 px, 299/299 px. Both pages have zero horizontal overflow.
- Motion: 650 ms entrance transitions, staggered groups, button/arrow feedback, and a 900 ms bar reveal. Actual browser readback observed entrance opacity 0 / translateY(24px), then opacity 1 / translateY(0). A further bug was found: the bar played before the bar itself entered the viewport. It now has its own visibility observation. Fresh-browser readback: below viewport at top 1113 px, animation none / scaleX(0); after scrolling to top 692 px, `is-visible`, animation `cashflow-grow`, finally scaleX(1). Reduced-motion CSS remains enabled; OS emulation was not performed.
- Interruption recovery: the preview server had stopped while cached UI still rendered. Restarted an isolated smoke server with synthetic storage and LINE replies/AI parsing disabled. Used a fresh localhost origin for the final motion check to avoid stale static resources. Current preview: http://localhost:5198/ .
- Regression coverage: added assertions for consent error visibility, minimum spacing, page overflow, and clearing after consent to `webapp/scripts/smoke-test-page.js`. Its syntax was checked; the full raw-CDP runner was not executed. Equivalent visible UI flows were exercised through CUA. This is targeted verification of the reported states, not an exhaustive audit of every product screen.

## Required fidelity surfaces

- Typography: Noto Serif TC display headings and prominent amounts; Noto Sans TC forms and body. Desktop hierarchy and mobile wrapping reviewed. The source lettering is generative, so these are intentional production font choices.
- Spacing: centered masthead, broad photograph, editorial invitation, summary, bar and ledger follow the reference order. Mobile stacks content and preserves table readability. Restrained radii and shadows replace the earlier glass panels.
- Colors: ivory background, deep green type, sage positive values, ochre expenditure/action accents. Negative cashflow retains an explicit danger color and explanatory text.
- Images: generated warm home and notebook photographs match the selected subject and palette; correct crops, no stretched images, no fabricated handwritten text or brand marks. Standard Bootstrap icons use their upstream SVG assets.
- Copy: examples are explicitly labelled, with the recent rows identified as a subset. Actual financial values come from the existing ledger; budgets are not substituted for missing income.

Accepted differences: original asset compositions replace mock book/cup lettering; the bar places outflows before remaining funds consistently in sample and live summaries; local unconfigured authentication controls follow the existing runtime configuration. This is a chosen-style implementation, not a pixel-identical clone.

## Interaction and regression evidence

- Main CTA reaches the existing guided form; advanced entry opens household inputs.
- Income 45000 and fixed expense 28000 were applied to all months, saved, reloaded and checked in December.
- Added synthetic ETF 0050 / 5000, saved, deleted, saved and reloaded: holdings remained empty.
- Local save feedback explicitly states that the data is only in this browser when no linked account is available.
- Synthetic dashboard: income 42000, expenses 1510, remaining 40490; merchant Render.com is expense 230 in the table.
- Negative fixture: income unrecorded, expense 230, remaining -230; explicit shortfall equation and no imported budget income.
- Eight non-browser regression scripts passed; preserved log: `webapp/reports/journal-ledger-regressions.log` (ignored local evidence).
- Smooth scrolling, short button feedback, focus styling and reduced-motion handling are implemented. Reduced-motion OS emulation and an exhaustive keyboard audit were not performed.

## Release boundary and follow-up

- No push, deployment, real LINE message, paid AI statement call or customer ledger modification performed.
- Real LINE preview/confirmation, uploaded-image recognition and authenticated cloud reload must still be checked on the deployed build using `docs/ledger-release-checklist.md`.
- Existing browser smoke suite was updated but not rerun through its raw CDP runner in this session; UI verification used CUA. Payment, admin and every premium-report state were not exhaustively visually reviewed.
- Preview was restarted after interruption; stopped servers can leave cached HTML without images. Keep the local server running during review.
- Implementation checklist complete for local handoff: assets, theme, financial visualization, mobile table, save/reload verification, source comparison and QA record.
