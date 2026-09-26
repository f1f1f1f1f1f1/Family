import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Regression guard for a UI bug where the "Family" dashboard layout
 * (DashboardView's default layout, described in Settings as "Per-member
 * calendar columns") was actually rendering family members as full-width
 * horizontal rows stacked vertically (`.dash-family-grid { flex-direction:
 * column }`) instead of side-by-side vertical columns. jsdom doesn't run a
 * real layout engine, so this can't screenshot-diff the result — instead it
 * asserts the actual CSS source defines a column-based grid, which is the
 * property that broke silently before (class names like "dash-member-col"
 * suggested columns while the CSS quietly did rows).
 */

const DASHBOARD_CSS = path.resolve(__dirname, '../styles/dashboard.css');

describe('dashboard "Family" layout renders members as columns, not stacked rows', () => {
  const css = readFileSync(DASHBOARD_CSS, 'utf-8');

  function ruleBodyFor(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`Rule "${selector}" not found in dashboard.css`);
    return match[1];
  }

  it('.dash-family-grid uses a multi-column grid keyed off --member-count', () => {
    const body = ruleBodyFor('.dash-family-grid');
    expect(body).toMatch(/display:\s*grid/);
    expect(body).toMatch(/grid-template-columns:.*--member-count/);
    // The bug: this used to be `display: flex; flex-direction: column`,
    // which stacks each member's entire section as a full-width row.
    expect(body).not.toMatch(/flex-direction:\s*column/);
  });

  it('member columns never push the sidebar off-screen', () => {
    // A 960px-wide Echo Show with 4 members was ~110px too narrow for the
    // member columns' minimum widths, so the main column grew past the
    // screen edge and cut off the Tasks sidebar. The main column must be
    // allowed to shrink, with members that don't fit scrolling sideways.
    expect(ruleBodyFor('.dashboard')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(ruleBodyFor('.dash-family-grid')).toMatch(/overflow-x:\s*auto/);
  });

  it('.dash-member-col is a vertical flex column (content stacks top-to-bottom WITHIN each member column)', () => {
    // This one legitimately should be flex-direction: column — that's
    // correct for the events *inside* a single member's column. The bug
    // was one level up, at .dash-family-grid.
    const body = ruleBodyFor('.dash-member-col');
    expect(body).toMatch(/flex-direction:\s*column/);
  });

  it('collapses back to a single stacked column below the tablet breakpoint (768px)', () => {
    const mediaMatch = css.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}\n\n\/\* ─── Responsive: Phone/);
    expect(mediaMatch, 'tablet media query block not found').toBeTruthy();
    const tabletBlock = mediaMatch![1];
    const gridOverride = tabletBlock.match(/\.dash-family-grid\s*\{([^}]*)\}/);
    expect(gridOverride, '.dash-family-grid override not found in tablet breakpoint').toBeTruthy();
    expect(gridOverride![1]).toMatch(/grid-template-columns:\s*1fr/);
  });
});
