# DealRipe memory index

- [Extraction UI pacing](feedback_extract_animation.md) — simultaneous reveal on API return, 4s floor on loading state, no staggered setTimeouts
- [Scotsman extraction merge semantics](feedback_extraction_merge.md) — new results merge with prior; never demote a Yes
- [NEW field treatment persistence](feedback_new_treatment.md) — newly-promoted Yes fields keep a persistent diff marker (tint + border + NEW tag) across page refreshes, tagged via `lastUpdatedFromCallId`
- [Demo constraint](project_demo_date.md) — April 24, 2026 Paul Foreman demo governs all scope decisions
