export const HEARTBEAT_MS = 20_000;

export const STALE_AFTER_MS = 120_000;

/**
 * Calls `beat` every HEARTBEAT_MS until the returned function is called. A
 * beat that throws is handed to `missed` rather than ending the process, since
 * a few missed beats fit within STALE_AFTER_MS.
 */
export const startHeartbeat = (
  beat: () => void,
  missed: (error: unknown) => void,
): (() => void) => {
  const timer = setInterval(() => {
    try {
      beat();
    } catch (error) {
      missed(error);
    }
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
};
