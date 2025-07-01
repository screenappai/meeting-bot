# Graceful Shutdown Implementation

This document explains how the graceful shutdown mechanism works in the meeting-bot application and how to use it effectively.

## Overview

The graceful shutdown mechanism ensures that the application properly handles shutdown signals (SIGTERM, SIGINT, SIGABRT) by:

1. **Preventing new jobs** from being accepted
2. **Waiting for ongoing tasks** to complete naturally
3. **Shutting down the HTTP server** only after all tasks are done
4. **Exiting the application** cleanly

## How It Works

### 1. Signal Handling

When a shutdown signal is received, the application:

```typescript
// In src/index.ts
const initiateGracefulShutdown = async () => {
  // Set the graceful shutdown flag
  setGracefulShutdown(1);
  
  // Request shutdown on the job store (prevents new jobs from being accepted)
  globalJobStore.requestShutdown();
  
  // Wait for ongoing tasks to complete (no timeout - wait indefinitely)
  await globalJobStore.waitForCompletion();
  
  // Now proceed with application shutdown
  gracefulShutdownApp();
};
```

### 2. JobStore Integration

The `JobStore` class has been enhanced with shutdown capabilities:

```typescript
// In src/lib/JobStore.ts
export class JobStore {
  private shutdownRequested: boolean = false;
  private currentTaskPromise: Promise<any> | null = null;

  // Prevents new jobs from being accepted when shutdown is requested
  async addJob<T>(task: () => Promise<T>, logger: Logger): Promise<{ accepted: boolean }> {
    if (this.isRunning || this.shutdownRequested) {
      return { accepted: false };
    }
    // ... rest of implementation
  }

  // Request graceful shutdown
  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  // Wait for ongoing tasks to complete
  async waitForCompletion(): Promise<void> {
    // Implementation that waits for tasks to complete naturally
  }

  // Check if shutdown has been requested
  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }
}
```

### 3. Task Integration

Tasks can check for shutdown requests and implement graceful behavior:

```typescript
// In src/lib/Task.ts
export abstract class Task<I, O> {
  // Check if shutdown has been requested
  protected isShutdownRequested(): boolean {
    return isShutdownRequested();
  }

  // Wait with shutdown check
  protected async waitWithShutdownCheck(ms: number, checkInterval: number = 100): Promise<void> {
    // Implementation that checks for shutdown during wait
  }
}
```

## Usage Examples

### 1. Basic Task Implementation

```typescript
export class MyTask extends Task<InputType, OutputType> {
  protected async execute(input: InputType): Promise<OutputType> {
    // Check for shutdown before starting
    if (this.isShutdownRequested()) {
      throw new Error('Shutdown requested before task execution');
    }

    // Your task logic here
    const result = await this.performWork(input);

    // Check for shutdown during execution
    if (this.isShutdownRequested()) {
      // Clean up and exit gracefully
      await this.cleanup();
      throw new Error('Shutdown requested during task execution');
    }

    return result;
  }
}
```

### 2. Long-Running Task with Periodic Checks

```typescript
export class LongRunningTask extends Task<InputType, OutputType> {
  protected async execute(input: InputType): Promise<OutputType> {
    for (let i = 0; i < 100; i++) {
      // Check for shutdown every iteration
      if (this.isShutdownRequested()) {
        this._logger.info('Shutdown requested, stopping task gracefully');
        await this.cleanup();
        throw new Error('Shutdown requested during long-running task');
      }

      // Do work
      await this.processItem(i);
      
      // Wait with shutdown check instead of regular setTimeout
      await this.waitWithShutdownCheck(1000); // Wait 1 second
    }

    return result;
  }
}
```

### 3. Using the Global JobStore

```typescript
import { globalJobStore, isShutdownRequested, isJobStoreBusy } from './lib/globalJobStore';

// Check if shutdown is requested
if (isShutdownRequested()) {
  console.log('Application is shutting down');
}

// Check if job store is busy
if (isJobStoreBusy()) {
  console.log('Job store is currently processing a task');
}
```

## Configuration

### Wait Settings

The graceful shutdown waits indefinitely for tasks to complete:

- **Job completion wait**: No timeout - waits until all tasks complete naturally
- **Task wait check interval**: 1000ms (checks every 1 second if tasks are still running)

### Environment Variables

You can configure shutdown behavior through environment variables:

```bash
# Set custom check interval for shutdown requests (in milliseconds)
SHUTDOWN_CHECK_INTERVAL=1000
```

## Best Practices

### 1. Always Check for Shutdown

```typescript
// Good: Check before starting work
if (this.isShutdownRequested()) {
  return; // Exit gracefully
}

// Good: Check during long operations
for (const item of items) {
  if (this.isShutdownRequested()) {
    break; // Exit loop gracefully
  }
  await processItem(item);
}
```

### 2. Use waitWithShutdownCheck for Delays

```typescript
// Good: Use the provided method
await this.waitWithShutdownCheck(5000); // 5 seconds with shutdown checks

// Avoid: Direct setTimeout
setTimeout(() => {}, 5000); // No shutdown awareness
```

### 3. Implement Proper Cleanup

```typescript
protected async execute(input: InputType): Promise<OutputType> {
  try {
    // Your task logic
    return result;
  } catch (error) {
    if (this.isShutdownRequested()) {
      await this.cleanup();
    }
    throw error;
  }
}

private async cleanup(): Promise<void> {
  // Clean up resources, close connections, etc.
  this._logger.info('Cleaning up task resources');
}
```

### 4. Log Shutdown Events

```typescript
if (this.isShutdownRequested()) {
  this._logger.info('Shutdown requested, stopping task gracefully');
  // ... cleanup and exit
}
```

## Monitoring and Debugging

### Health Check Endpoints

The application provides endpoints to monitor shutdown status:

- `/isbusy` - Returns whether the job store is currently busy
- `/metrics` - Prometheus metrics including busy status

### Logging

The graceful shutdown process logs important events:

```
SIGTERM signal received. Starting Graceful Shutdown
Initiating graceful shutdown...
Waiting for ongoing tasks to complete...
All tasks completed successfully
HTTP server closed. Exiting application
Exiting.....
```

### Troubleshooting

1. **Tasks not completing**: Check if tasks are properly implemented and not stuck in infinite loops
2. **Long wait times**: The application will wait indefinitely for tasks to complete - this is by design
3. **Resource leaks**: Ensure tasks implement proper cleanup in their shutdown handlers

## Testing

To test the graceful shutdown mechanism:

1. Start the application
2. Trigger a long-running task
3. Send a SIGTERM signal: `kill -TERM <pid>`
4. Verify that the task completes before the application exits

```bash
# Test with a long-running task
curl -X POST http://localhost:3000/google/join -d '{"duration": 120}'

# In another terminal, send shutdown signal
kill -TERM <application_pid>

# Check logs for graceful shutdown sequence
``` 