import { describe, it, expect, vi, beforeEach } from 'vitest';

import { escapeHtml, isValidSegment } from '../../app/recordings';

describe('escapeHtml', () => {
  it('should escape <', () => {
    expect(escapeHtml('<')).toBe('&lt;');
  });

  it('should escape >', () => {
    expect(escapeHtml('>')).toBe('&gt;');
  });

  it('should escape &', () => {
    expect(escapeHtml('&')).toBe('&amp;');
  });

  it('should escape "', () => {
    expect(escapeHtml('"')).toBe('&quot;');
  });

  it('should escape all special chars in one string', () => {
    expect(escapeHtml('<script>alert("x&y")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;'
    );
  });

  it('should leave safe strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('isValidSegment', () => {
  it('should block ..', () => {
    expect(isValidSegment('..')).toBe(false);
  });

  it('should block strings containing /', () => {
    expect(isValidSegment('foo/bar')).toBe(false);
  });

  it('should block strings containing \\', () => {
    expect(isValidSegment('foo\\bar')).toBe(false);
  });

  it('should block empty string', () => {
    expect(isValidSegment('')).toBe(false);
  });

  it('should accept normal alphanumeric', () => {
    expect(isValidSegment('user123')).toBe(true);
  });

  it('should accept base64url-safe string', () => {
    expect(isValidSegment('QWxwaGEtQmV0YS0xMjM')).toBe(true);
  });

  it('should accept string with dots but not ..', () => {
    expect(isValidSegment('file.webm')).toBe(true);
  });
});
