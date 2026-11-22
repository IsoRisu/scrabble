# Scrabble Mobile UX & Architecture Audit Report

**Role:** Senior Mobile Frontend Engineer & UX Auditor  
**Scope:** Review of `static/app.js`, `static/style.css`, `templates/game.html`, and current lobby/gameplay layout for mobile viewport usage.

---

## 1. Performance & Rendering
- **Issue:** The DOM unnecessarily renders all 16 static player slot elements upfront via JavaScript (`renderPlayers`), regardless of whether 2 or 16 players are active. This increases DOM tree size and layout recalculation costs on low-end mobile devices.
- **Issue:** Re-rendering the entire board (`buildBoard()` and full cell signature checks) whenever bounds or tile state shifts triggers excessive reflows and repaints, especially during continuous pinch-zoom or panning interactions.
- **Technical Solutions:**
  - **Virtualization & Conditional Generation:** Only render active player cards plus placeholders up to `max_players`, recycling DOM nodes rather than clearing and rebuilding the container innerHTML on every socket state diff.
  - **Granular Reactivity / Diffing:** Update individual board cells via direct DOM reference lookup (`cells.get(key)`) rather than re-evaluating unchanged cell signatures across the entire 27x19 or 15x15 grid.

## 2. UX Flaws
- **Issue:** In the waiting lobby and during active play, stacked bottom sheets and fixed overlay panels overlap with the game board and rack, causing severe vertical crampedness on mobile viewports (e.g., iPhone SE).
- **Issue:** Disabled action buttons (Pass, Swap, Submit) take up valuable horizontal and vertical real estate in the bottom control bar even when inactive or irrelevant, cluttering the interaction area.
- **Technical Solutions:**
  - **Collapsible Drawer / Tab Architecture:** House secondary views (Tile Tracker, Move History, Share Link) inside a dedicated, scrollable modal/drawer accessible via the cog menu rather than cluttering overlay stacks.
  - **Contextual Action Bar:** Dynamically hide or ghost out disabled action buttons or group them into a secondary overflow menu when not actionable on the user's turn.

## 3. Accessibility (a11y)
- **Issue:** Touch targets for rack tiles and board cells can fall below the recommended 44×44px threshold on smaller screens without zoom enabled (e.g., standard viewport scaling yields ~21px per square on 375px screens).
- **Issue:** Contrast ratios between specific premium square backgrounds (e.g., light blue DL `#abe6ff` or light green TL `#aef6ab`) and dark ink text (`rgba(74, 36, 22, .62)`) can drop below WCAG AA standards (4.5:1).
- **Technical Solutions:**
  - **Enforced Minimum Touch Sizes & Zoom Pre-scaling:** Auto-enable board zoom on mobile viewports ($\le 700\text{px}$) so square dimensions exceed 44px by default, paired with robust pointer capture.
  - **Contrast Hardening:** Darken premium square label text and background tint saturation to guarantee $\ge 4.5:1$ contrast against text and icons across all themes.
  - **Screen Reader Enhancements:** Ensure robust `aria-live` regions for turn notifications and tile placement previews, and add clear `aria-label` attributes on board coordinate gridcells indicating premium bonuses and placed letters.

## 4. Responsive Design
- **Issue:** Fixed layout scaling between small devices (iPhone SE, 375×667) and large devices (iPhone 15 Pro Max, 430×932) causes aspect ratio distortion or excessive scrolling if viewport safe-area insets (`env(safe-area-inset-bottom)`) are not properly factored into bottom sheet offsets.
- **Technical Solutions:**
  - **CSS Grid & Flexbox Viewport Constraints:** Adopt a pure CSS viewport grid (`vh`/`vw` units combined with `safe-area-inset-*`) keeping the board centered and scaling fluidly without breaking fixed action drawers.
  - **Media Query Breakpoints:** Refine media queries at 520px and 700px thresholds to collapse player card grids into horizontal scrollable pill lists or compact 2-column cards.
