# GitTree Design System

## Direction

GitTree is a premium, minimal desktop Git interface for developers. It combines calm, system-native clarity with a practical bento workspace: generous structure, compact data presentation, completely opaque surfaces, and a near-monochrome palette led by midnight blue.

The interface must feel bright, stable, precise, and calm. Visual hierarchy comes from spacing, solid tonal steps, thin borders, and soft elevation—not transparency or decoration.

## Non-negotiable rules

- Use opaque surfaces for every functional component.
- Use gradients only on the outer application canvas through `--canvas-gradient`.
- Never use glassmorphism, backdrop blur, glow effects, illuminated borders, reflections, neumorphism, or frosted effects.
- Modal backdrops may use the flat translucent `--modal-backdrop` token only; dialog surfaces themselves stay fully opaque.
- Never apply gradients to panels, cards, controls, tables, dialogs, overlays, or navigation.
- Use semantic tokens from `src/renderer/styles/variables.css`; do not add raw colors elsewhere in renderer code.
- Use Phosphor regular icons. Do not use emoji, Unicode pictograms, or mixed icon weights.
- Use pill shapes for buttons, search fields, tabs, chips, and segmented controls. Use large rounded rectangles for panels and cards.
- Preserve WCAG 2.2 AA contrast and visible keyboard focus.

## Foundations

### Color

Light theme is the product default. Dark is the fully opaque alternative. Each theme exposes five surface tones.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas | pastel `--canvas-gradient` | deep navy `--canvas-gradient` |
| Shell | `#F7F9FC` | `#121A27` |
| Primary surface | `#FFFFFF` | `#182230` |
| Secondary surface | `#F2F5F9` | `#202C3B` |
| Primary text | `#101828` | `#F4F7FB` |
| Secondary text | `#475467` | `#B8C3D2` |
| Primary action | `#102A4C` | `#DCE9F8` |
| Subtle border | `#E3E8EF` | `#2A394B` |
| Informational signal | `#176B7A` | `#00F5FF` |

Semantic status colors are always paired with text or an icon. Never rely on color alone. Dark may use a high-chroma solid cyan for informational signals, sync state, HEAD, and non-critical selection. This is a semantic color—not a neon effect—and must never be paired with glow, colored shadows, transparency, or illuminated borders. Amber remains reserved for real warnings, dirty state, and risky actions.

### Typography

- UI and body: `DM Sans` primary, `Inter` fallback, self-hosted variable fonts (`styles/fonts.css`); system sans-serif stack as fallback.
- Display headings: `--font-display`, semibold, tight negative tracking.
- Code, hashes, branch names, paths, and keyboard hints: `--font-mono`.
- Core scale: 11, 12, 13, 14, 16, 20, 28, and 40px.
- Body copy uses 1.45–1.65 line height. Dense data rows may use 1.35.

### Spacing, radius, and elevation

- Spacing follows the 4px scale: 4, 8, 12, 16, 20, 24, 32, and 40px.
- Bento panels use 18–24px radius.
- Nested cards and dialogs use 12–18px radius.
- Pills use `--radius-pill`.
- Use only `--shadow-sm`, `--shadow-md`, or `--shadow-lg`. Shadows must remain diffuse and neutral.

### Motion

- Use 140ms for control feedback and 220ms for panel/state changes.
- CSS animations and transitions may animate only `transform` and `opacity`.
- Keep motion functional and honor `prefers-reduced-motion`.
- Do not animate backgrounds on dense scroll rows. Immediate hover feedback avoids repeated paint work while scrolling.
- Follow `MOTION.md` for panel transitions, direct manipulation, lifecycle, and measurement contracts.

### Performance

- Treat renderer performance as a product requirement; preserve all features while reducing layout and paint work.
- Dense lists must isolate offscreen rows with `content-visibility` and layout/paint containment.
- Do not attach shadows to every bento panel or graph node. Use borders and solid tonal separation on scroll-heavy surfaces.
- Resizable workspace panels must follow the pointer in realtime by coalescing movement to at most one grid CSS-variable write per `requestAnimationFrame`. Visible content remains fully opaque and mounted throughout the drag; persist the final width exactly once on release.
- Selection changes must update the affected rows in place; never rebuild the full commit list for a single selection.
- Run the deterministic renderer benchmark after changes to layout, scrolling, lists, diff rendering, or panel resizing.

## Workspace architecture

The desktop workspace is a resizable three-panel bento:

1. Branch navigator: local/remote branches, search, stashes, and tags.
2. Commit history: primary work area with repository search and remote actions.
3. Inspector: commit details and unified/split diff.

The left and right widths persist locally. The history panel always receives the remaining width. At narrower breakpoints the inspector hides first, then the branch navigator. Conflict resolution uses an opaque shell; merge preview and settings are resizable modals over a flat `--modal-backdrop` dim.

The desktop window is frameless. The repository tabs are the first visible row of the application card: do not add a native menu, a separate title bar, or a GitTree brand label above or beside them. Keep minimize, maximize, and close controls inside the tab row, and preserve a draggable empty area between the tabs and right-side actions.

## Component contracts

### Buttons and icon controls

- Buttons are at least 34px high and pill-shaped.
- Primary buttons use a solid midnight-blue background in light mode.
- Icon-only controls are circular, at least 34×34px, and require a tooltip or accessible label.
- Provide default, hover, focus-visible, active, disabled, and loading states where relevant.
- Active feedback may use `scale(0.98)`; never add glow.

### Inputs and search

- Inputs use solid `--surface-input`, a 1px semantic border, and a pill radius.
- Focus uses a 2px `--border-focus` outline with an offset.
- Placeholder text uses `--text-tertiary`.
- Search palettes use an opaque full-screen background and an elevated opaque panel.

### Bento panels and cards

- Top-level panels use `--surface-primary`, `--border-subtle`, `--radius-lg`, and `--shadow-sm`.
- Nested cards use a solid tonal change before adding elevation.
- Avoid nested cards deeper than two levels.
- Data-dense lists use row dividers or hover fills, not individual floating cards.

### Tabs, chips, badges, and segmented controls

- Tabs and chips are pills on solid secondary surfaces.
- Selected states use `--primary-soft` and a clear text/icon change.
- Badges use muted semantic fills and concise labels.
- Segmented controls place solid buttons inside a solid secondary track.

### Tables, graphs, and diffs

- Keep row heights between 34 and 40px for balanced developer density.
- Make headers sticky, opaque, and visually quieter than the data.
- Use monospace only for technical values.
- Diff additions/deletions use solid semantic backgrounds from the diff token family.

### Dialogs, toasts, and full-screen workflows

- Dialog overlays use the flat translucent `--modal-backdrop` dim; dialog surfaces themselves use `--surface-primary` and stay fully opaque.
- Dialogs are resizable with min/max clamps; resize never shrinks a surface below its usable minimum.
- Toasts use borders and soft elevation; status is never communicated by color alone.
- Merge and conflict views retain the same spacing, radius, component, and icon rules.

## Themes and localization

- Theme state is stored under `gittree.theme`; first launch defaults to `light`.
- Language state is managed by i18next under `gittree.language`, with English fallback and system-locale detection.
- User-visible static strings use `data-i18n` attributes.
- Dynamic strings call `t(key, options)`.
- New features must add English and Italian keys together.
- Do not concatenate translated fragments when a sentence requires different grammar; translate the complete sentence.

## Accessibility and content

- All interactive elements must be keyboard reachable and show `:focus-visible`.
- Icon-only controls need an accessible name.
- Text and controls must meet WCAG 2.2 AA contrast.
- Use concise, literal product copy. Prefer verbs such as “Open repository”, “Create branch”, and “Resolve conflicts”.
- Empty, loading, error, and disabled states are required for data-driven components.
- Truncate long technical labels visually while preserving the full value in `title` or accessible text.

## Review checklist

- Outer canvas is the only gradient-bearing surface.
- Every component surface is fully opaque.
- No raw renderer colors exist outside `variables.css`.
- No glass, blur, glow effects, emoji, or Unicode icons are present.
- Light and dark themes both preserve hierarchy and contrast.
- English and Italian keys are present for new user-facing copy.
- Buttons, fields, tabs, dialogs, lists, empty states, and error states use shared contracts.
- AI generation controls disable during flight and show a spinner; results fill editable fields and never replace user text without confirmation.
- Keyboard focus, overflow, narrow layouts, and long repository/branch names are tested.
- `npm run audit:design` passes.
- `npm run perf:renderer` launches an isolated Playwright Electron fixture and passes its deterministic renderer contracts.
