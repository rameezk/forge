export const HEARTBEAT_MS = 20_000;

export const STALE_AFTER_MS = 120_000;

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
