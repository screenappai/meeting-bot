import { JobStore } from './JobStore';

// Create a global job store instance
export const globalJobStore = new JobStore();

// Utility functions for easier access
export const isShutdownRequested = (): boolean => globalJobStore.isShutdownRequested();
export const isJobStoreBusy = (): boolean => globalJobStore.isBusy(); 