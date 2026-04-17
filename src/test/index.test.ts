import { describe, it, expect } from 'vitest';

describe('Module import verification', () => {
  it('should import SilenceMonitor', async () => {
    const mod = await import('../lib/meeting-end/SilenceMonitor');
    expect(mod.SilenceMonitor).toBeDefined();
    expect(typeof mod.SilenceMonitor).toBe('function');
  });

  it('should import ParticipantStateResolver', async () => {
    const mod = await import('../lib/meeting-end/ParticipantStateResolver');
    expect(mod.ParticipantStateResolver).toBeDefined();
    expect(typeof mod.ParticipantStateResolver).toBe('function');
  });

  it('should import MeetingEndDecisionEngine', async () => {
    const mod = await import('../lib/meeting-end/MeetingEndDecisionEngine');
    expect(mod.MeetingEndDecisionEngine).toBeDefined();
    expect(typeof mod.MeetingEndDecisionEngine).toBe('function');
  });

  it('should import RecordingRetentionPolicy', async () => {
    const mod = await import('../lib/storage/retention');
    expect(mod.RecordingRetentionPolicy).toBeDefined();
    expect(typeof mod.RecordingRetentionPolicy).toBe('function');
  });

  it('should import types from meeting-end/types', async () => {
    const types = await import('../lib/meeting-end/types');
    expect(types).toBeDefined();
  });

  it('should import types from storage/types', async () => {
    const types = await import('../lib/storage/types');
    expect(types).toBeDefined();
  });
});
