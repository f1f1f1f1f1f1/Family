/**
 * A change the add-on server didn't store (it was unreachable, or answered
 * with an error). The change is not kept anywhere: the screen goes back to
 * what the server has, and App shows a short "couldn't save" notice.
 */
export class SaveFailedError extends Error {
  constructor(what: string) {
    super(`Couldn't save ${what}`);
    this.name = 'SaveFailedError';
  }
}

const listeners = new Set<(err: SaveFailedError) => void>();

/** Tell whoever shows the notice (App) that a save failed. */
export function reportSaveFailed(err: SaveFailedError): void {
  listeners.forEach((listener) => listener(err));
}

export function onSaveFailed(listener: (err: SaveFailedError) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs a change, then `after` (a refresh) whether or not it saved. A
 * SaveFailedError has already been reported, so it isn't passed on to
 * callers that tap-and-forget; any other error is.
 */
export async function saveThen(change: () => Promise<unknown>, after: () => Promise<void> | void): Promise<void> {
  try {
    await change();
  } catch (err) {
    if (!(err instanceof SaveFailedError)) throw err;
  } finally {
    await after();
  }
}
