// Ensure global Web Crypto API is available (needed by Azure SDK, polyfill for older Node versions)
import './shims/crypto-polyfill';
import http from 'http';
import app, { redisConsumerService, setGracefulShutdown } from './app';
import { globalJobStore } from './lib/globalJobStore';
import messageBroker from './connect/messageBroker';
import config from './config';
import { isPodMarkedForDeletion } from './util/k8sLifecycle';
import { loggerFactory } from './util/logger';

const port = 3000;

// Create Express server
const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Detect the "SIGTERM lost during ContainerCreating" race: if K8s marked us for deletion
// before the container's PID 1 existed, the SIGTERM was silently dropped. Without this
// check, the bot would run normally for the full terminationGracePeriodSeconds.
//
// 10s delay so kubelet has first chance to deliver SIGTERM via the normal path
// (when it does work) — this check is the fallback for the broken case. Safe even
// if SIGTERM also fires: initiateGracefulShutdown is idempotent (guards on shutdownInProgress).
const startupLogger = loggerFactory('startup', 'system');
setTimeout(() => {
  isPodMarkedForDeletion(startupLogger)
    .then((isDeleted) => {
      if (isDeleted) {
        console.log('Pod marked for deletion at startup — initiating graceful shutdown');
        initiateGracefulShutdown();
      }
    })
    .catch((err) => {
      console.error('Startup pod-deletion check threw (continuing normal startup):', err);
    });
}, 10000);

// Flag to prevent multiple shutdown attempts
let shutdownInProgress = false;

const initiateGracefulShutdown = async () => {
  if (shutdownInProgress) {
    console.log('Shutdown already in progress, ignoring signal');
    return;
  }

  shutdownInProgress = true;
  console.log('Initiating graceful shutdown...');

  try {
    // Set the graceful shutdown flag
    setGracefulShutdown(1);

    // Request shutdown on the job store (prevents new jobs from being accepted)
    globalJobStore.requestShutdown();

    // Wait for ongoing tasks to complete (no timeout - wait indefinitely)
    await globalJobStore.waitForCompletion();

    // Now proceed with application shutdown
    gracefulShutdownApp();
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
    // Force exit if graceful shutdown fails
    process.exit(1);
  }
};

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

process.on('SIGABRT', () => {
  console.log('SIGABRT signal received. Starting Graceful Shutdown');
  initiateGracefulShutdown();
});

export const gracefulShutdownApp = () => {
  // Complete existing requests, close database connections, etc.
  server.close(async () => {
    console.log('HTTP server closed. Exiting application');

    // Only shutdown Redis services if Redis is enabled
    if (config.isRedisEnabled) {
      await redisConsumerService.shutdown();
      await messageBroker.quitClientGracefully();
    } else {
      console.log('Redis services not running - skipping Redis shutdown');
    }

    console.log('Exiting.....');
    process.exit(0);
  });
};
