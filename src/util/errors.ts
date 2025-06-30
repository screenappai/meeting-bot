import playwright from 'playwright';

export function flattenError(
  err: unknown,
): string {
  try {
    function toSingleLine(str: string): string {
      return str.replace(/[\r\n]+/g, ' ').replace(/\s\s+/g, ' ').trim();
    }

    if (!err) {
      return 'Unknown error (null or undefined)';
    }

    if (
      typeof err === 'string' ||
      typeof err === 'number' ||
      typeof err === 'boolean' ||
      typeof err === 'symbol'
    ) {
      const result = String(err).trim();
      return toSingleLine(result || '[Empty Error]');
    }

    if (
      err instanceof playwright.errors.TimeoutError
    ) {
      const name = err.name || 'TimeoutError';
      const message = (err as Error).message || '';
      const stackFirstLine = (err as Error).stack?.split('\n')[0] || '';
      const parts = [name, message, stackFirstLine].filter(Boolean);
      const result = parts.join(' | ');
      return toSingleLine(result || name || message || '[Playwright TimeoutError]');
    }

    if (err instanceof Error) {
      const name = err.name || 'Error';
      const message = err.message || '';
      const stackFirstLine = err.stack?.split('\n')[0] || '';
      const parts = [name, message, stackFirstLine].filter(Boolean);
      const result = parts.join(' | ');

      if (result) return toSingleLine(result);
      if (message) return toSingleLine(message);
      if (name) return toSingleLine(name);

      return '[Error object without message or name]';
    }


    const asString = String(err).trim();
    if (asString && asString !== '[object Object]') {
      return toSingleLine(asString);
    }
    const json = JSON.stringify(err);
    if (json && json !== '{}') {
      return toSingleLine(json);
    }
    return '[Object error without message]';
  } catch {
    return '[Unserializable error object]';
  }
}
