---
title: 'Match the supplied black and gold website reference'
type: 'feature'
created: '2026-09-06'
status: 'done'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent">

## Intent

Restyle AgentDesk to match the supplied screenshot: black page, charcoal navigation, yellow accent strip, bold gold headings, generous spacing, and rounded subtly gold-tinted cards. Apply the palette throughout the application and compose the public home around a centered introduction and three feature cards. Preserve AgentDesk identity, existing language, routes, session redirect and application behavior.

</frozen-after-approval>

## Implementation Notes

- Small reversible presentation change; no API or data changes. Existing deployment JSON modification belongs to the user and is excluded.
- Update global theme, shared header/card, public home, dashboard navigation and marketplace card border. Keep semantic status colors distinct and retain light theme support.
- Verify TypeScript, relevant existing UI tests, lint, and desktop/mobile browser rendering.

- Implemented six presentation files; retained session routing and status colors. Home uses a 28px card radius and the reference yellow strip; shared cards and dashboard destinations use warm gold surfaces.
- Verification: web TypeScript and changed-file ESLint pass; 36 existing marketplace, dashboard and workflow UI tests pass; production Docker build passes. Desktop home visually checked at 1440px; public mobile home/sign-in checked for overflow. Authenticated data pages require a session and were covered by existing component tests, not a signed-in browser walkthrough.

## Review Triage Log

- Low, patched: horizontal navigation scrollport clipped focus outlines. Removed the scrollport and restored wrapping.
- Medium, patched: mobile CSS ordering differed from DOM keyboard order. Removed order overrides.
- Low, rejected: CTA follows feature cards on mobile. The sticky header already exposes sign-in; retaining the introduction/cards composition matches the supplied reference, so an additional duplicate CTA is unnecessary.
- Low, patched: horizontally hidden destinations lacked an overflow affordance. Wrapping makes every navigation destination visible.
