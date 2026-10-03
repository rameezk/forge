export interface BeforeProviderRequestEvent {
  type: 'before_provider_request';
  payload: unknown;
}

export interface ExtensionApi {
  on(
    event: 'before_provider_request',
    handler: (event: BeforeProviderRequestEvent) => unknown,
  ): void;
}

const withoutReasoning = (payload: unknown): unknown => {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('reasoning' in payload)
  ) {
    return undefined;
  }
  const { reasoning: _reasoning, ...rest } = payload as Record<string, unknown>;
  return rest;
};

export default function modelDefaultReasoningExtension(pi: ExtensionApi): void {
  pi.on('before_provider_request', ({ payload }) => withoutReasoning(payload));
}
