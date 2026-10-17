---
name: design-system
description: Use when designing or generating ThisProduct-branded interfaces, visual assets, prototypes, mocks, UI kits, or production UI with the ThisProduct design system.
---
## Usage

Use this skill when its frontmatter description matches the user request. Follow the workflow and constraints below.


# ThisProduct Design

Use the repo-local ThisProduct design system when creating branded interfaces, visual artifacts, prototypes, mocks, UI kits, or production UI for ThisProduct.

Reference root: `design system/`

## Required Reading

Start with `design system/readme.md`. It defines the brand idea, content fundamentals, visual foundations, iconography, and index of available assets.

If creating visual artifacts such as slides, mocks, or throwaway prototypes, produce static HTML or other viewable artifacts using the design system assets. If working on production code, apply the same tokens, components, and interaction patterns directly in the implementation.

If the user invokes this skill without enough direction, ask what they want to build or design, then proceed as an expert designer who can output either HTML artifacts or production code depending on the need.

## Quick map

- `design system/readme.md` - the design guide: brand idea, content fundamentals, visual foundations, iconography, and an index of everything.
- `design system/styles.css` - link this one file to get all tokens and fonts. It `@import`s everything in `tokens/`.
- `design system/tokens/` - color, typography, spacing, effects, fonts as CSS custom properties.
- `design system/components/` - React UI primitives: Logo, Button, IconButton, Input, Switch, Badge, Tag, Avatar, Card, and the signature `ModuleBlock`. Each has a `.d.ts` props file and `.prompt.md` usage file.
- `design system/ui_kits/thisproduct-app/` - a click-through recreation of the work-systems product: login, dashboard, builder canvas.
- `design system/brand/identity-board.html` - the full identity board: logo, color, type, modular system, applications.
- `design system/guidelines/` - small foundation specimen cards.

## Working with components

Components are bundled into `design system/_ds_bundle.js`. In an HTML file, link `design system/styles.css`, load React, Babel, and `_ds_bundle.js`, then read components from `window.ThisProductDesignSystem_69a035`. Icons use Lucide via CDN. See any `design system/components/**/**.card.html` file for the exact pattern.

Generated scratch files should stay outside the repo when possible. When repo-local temp files are necessary, remove them before final handoff unless the user explicitly asked to preserve them.

## The one-line brief

Lego's modular optimism, filtered through Clay's grown-up software taste. Warm, intelligent, modular, crafted: serious but not cold. Charcoal ink, warm paper, clay hero accent, brass and ember secondaries, selective brick accents.

Avoid campfire/flame imagery, cartoon sparks, wellness softness, toy primary colors, generic AI gradients, and emoji.

## Error Handling

- If required files, tools, connectors, credentials, or source artifacts are unavailable, state the blocker clearly and continue only with safe local evidence.
- If the user request requires missing product judgment or source-boundary approval, ask one focused question before proceeding.
