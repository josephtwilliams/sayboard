const lines = {
  account_request_failed: '{"event":"account_request_failed"}',
  hosted_handler_failed: '{"event":"hosted_handler_failed"}',
  postgres_idle_pool_error: '{"event":"postgres_idle_pool_error"}',
};

export function emitBackendFailure(event: keyof typeof lines): void {
  try {
    console.error(lines[event]);
  } catch {}
}
