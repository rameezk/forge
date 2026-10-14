interface ExtensionApi {
  on(
    event: 'cache_warming_decision',
    handler: () => { action: 'warm' },
  ): void;
}

export default function forceCacheWarm(pi: ExtensionApi): void {
  pi.on('cache_warming_decision', () => ({ action: 'warm' }));
}
