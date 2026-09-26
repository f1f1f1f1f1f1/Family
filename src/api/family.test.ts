import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FamilyStore } from './family';

/*
 * Runs against the real collection code in its standalone mode (no add-on
 * server), backed by localStorage.
 */

const store = new FamilyStore();

/** A local-time moment on a September 2026 day. */
const day = (date: number, hour = 9) => new Date(2026, 8, date, hour, 0);

async function completeOn(date: Date, choreId = 'c1', memberId = 'kai') {
  vi.setSystemTime(date);
  await store.completeChore(choreId, memberId);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FamilyStore streaks', () => {
  it("starts a streak of 1 on a member's first completion, counting each day once", async () => {
    await completeOn(day(20));
    await completeOn(day(20, 18), 'c2');

    expect(await store.getStreaks()).toEqual([
      { id: 'kai', member_id: 'kai', current: 1, longest: 1, last_completed: day(20).toISOString() },
    ]);
  });

  it('adds a day for each consecutive day with a completion', async () => {
    await completeOn(day(20));
    await completeOn(day(21));
    await completeOn(day(22, 20));

    expect(await store.getStreakForMember('kai')).toMatchObject({ current: 3, longest: 3 });
  });

  it('starts again at 1 after a missed day, keeping the best', async () => {
    await completeOn(day(20));
    await completeOn(day(21));
    await completeOn(day(23));

    expect(await store.getStreakForMember('kai')).toMatchObject({ current: 1, longest: 2 });
  });
});
