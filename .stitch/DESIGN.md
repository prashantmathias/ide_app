---
name: Obsidian Flux
colors:
  surface: '#10141a'
  surface-dim: '#10141a'
  surface-bright: '#353940'
  surface-container-lowest: '#0a0e14'
  surface-container-low: '#181c22'
  surface-container: '#1c2026'
  surface-container-high: '#262a31'
  surface-container-highest: '#31353c'
  on-surface: '#dfe2eb'
  on-surface-variant: '#c0c7d4'
  inverse-surface: '#dfe2eb'
  inverse-on-surface: '#2d3137'
  outline: '#8b919d'
  outline-variant: '#414752'
  surface-tint: '#a2c9ff'
  primary: '#a2c9ff'
  on-primary: '#00315c'
  primary-container: '#58a6ff'
  on-primary-container: '#003a6b'
  inverse-primary: '#0060aa'
  secondary: '#74dd7e'
  on-secondary: '#003910'
  secondary-container: '#007f2d'
  on-secondary-container: '#c4ffc2'
  tertiary: '#fabc45'
  on-tertiary: '#422c00'
  tertiary-container: '#d29922'
  on-tertiary-container: '#4d3500'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d3e4ff'
  primary-fixed-dim: '#a2c9ff'
  on-primary-fixed: '#001c38'
  on-primary-fixed-variant: '#004882'
  secondary-fixed: '#90fa97'
  secondary-fixed-dim: '#74dd7e'
  on-secondary-fixed: '#002106'
  on-secondary-fixed-variant: '#00531b'
  tertiary-fixed: '#ffdeaa'
  tertiary-fixed-dim: '#fabc45'
  on-tertiary-fixed: '#271900'
  on-tertiary-fixed-variant: '#5f4100'
  background: '#10141a'
  on-background: '#dfe2eb'
  surface-variant: '#31353c'
typography:
  ui-header:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.02em
  ui-body:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  ui-label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 16px
  code-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
  code-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  panel-gap: 1px
  sidebar-width: 260px
  gutter-width: 48px
  unit: 4px
  padding-xs: 4px
  padding-sm: 8px
  padding-md: 16px
  padding-lg: 24px
---

## Brand & Style

The brand personality is precise, technical, and high-performance, designed specifically for software engineers who require a focused environment for long-duration deep work. The UI evokes a sense of "digital craftsmanship"—where every pixel serves a functional purpose.

The design style merges **Minimalism** with **Glassmorphism**. It utilizes a "Dark Mode First" philosophy, leaning on deep obsidian surfaces and high-contrast typography to reduce eye strain. Glassmorphism is applied selectively to floating panels, tooltips, and overlays to maintain a sense of spatial depth without compromising the performance-oriented nature of an IDE. Borders are hair-line thin, and whitespace is used systematically to separate logical code blocks from administrative UI.

## Colors

The palette is anchored in a monochromatic dark range to minimize light emission. 
- **Primary (Electric Blue):** Used for active states, cursor focus, and primary action buttons.
- **Secondary (Soft Mint):** Reserved for success states, git additions, and terminal completions.
- **Tertiary (Muted Amber):** Applied to warnings, pending changes, and search highlights.
- **Neutral (Obsidian & Charcoal):** `surface` (#0d1117) acts as the editor backdrop, while `surface-alt` (#161b22) defines the sidebar and integrated terminal background to create clear structural separation.

Syntax highlighting is optimized for accessibility, ensuring a minimum contrast ratio of 4.5:1 against the obsidian background.

## Typography

This design system uses a dual-font strategy. **Inter** handles all UI elements (sidebars, menus, status bars), providing a neutral, professional tone that stays out of the way. **JetBrains Mono** is used exclusively for the editor and terminal, chosen for its increased x-height and distinct character shapes which reduce cognitive load during debugging.

Line heights in the editor are slightly generous (1.5x) to prevent "wall of text" fatigue. UI labels use slightly tighter tracking and uppercase styling to distinguish metadata from content.

## Layout & Spacing

The layout follows a **Fixed Grid** model for structural panels (Sidebar, Editor, Terminal) while utilizing a fluid model for the editor viewport itself. 

- **The 1px Rule:** Panels are separated by a 1px border rather than wide gutters to maximize screen real estate.
- **Breakpoints:** The system is optimized for desktop (1440px+). On smaller viewports (Tablets/Laptops), the sidebar collapses into an icon-only "Activity Bar."
- **Spacing Rhythm:** Based on a 4px base unit. Component padding (e.g., list items in a tree view) uses 8px (2 units) of horizontal padding and 4px (1 unit) of vertical padding to maintain high density.

## Elevation & Depth

Hierarchy is established via **Tonal Layers** and **Low-Contrast Outlines**. 
- **Level 0 (Base):** The editor surface (#0d1117).
- **Level 1 (Inlay):** Sidebars and bottom panels use a slightly lighter charcoal (#161b22).
- **Level 2 (Overlay):** Floating tooltips, command palettes, and dropdown menus use a semi-transparent background (85% opacity) with a `backdrop-filter: blur(12px)`. These elements are defined by a `1px` border of `#444c56` to separate them from the background.

Shadows are avoided except for floating modals, where a very subtle, large-radius black shadow (0 8px 24px rgba(0,0,0,0.5)) is used to suggest physical lift.

## Shapes

The design system uses **Soft** shapes (0.25rem/4px) for most interactive components. This slight rounding provides a modern feel without sacrificing the "industrial" aesthetic required for a developer tool. 

Tabs, buttons, and input fields utilize the standard 4px radius. Status indicators (dots) and avatar elements are the only components allowed to use "Pill-shaped" or circular rounding to contrast against the otherwise rectilinear grid.

## Components

- **Tabs:** Use a "Folder" metaphor. Active tabs have a top-border highlight of 2px in the Primary color. Inactive tabs have a semi-transparent background and no highlight.
- **Tree Views (Explorer):** High-density lists with 16px indentations per level. Hover states use a subtle background tint (#1f242c). Active file selection uses a full-bleed primary color background at 10% opacity.
- **Terminal Blocks:** Monospaced text against the `surface-alt` color. The prompt symbol is always the Secondary (Mint) color.
- **Input Fields:** Minimalist design with only a bottom border in the default state, turning into a full 1px primary border on focus. No inner shadows.
- **Status Indicators:** Located in the bottom bar. Errors use Tertiary (Amber) text; "Ready" states use the Secondary color. All status items are uppercase `ui-label-sm`.
- **Buttons:** Primary buttons are solid Electric Blue with white text. Secondary buttons are outlined with no fill. Both use a fixed height of 28px for UI density.