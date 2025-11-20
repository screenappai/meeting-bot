import http from 'http';
import app, { redisConsumerService, setGracefulShutdown } from './app';
import { globalJobStore } from './lib/globalJobStore';
import messageBroker from './connect/messageBroker';
import config from './config';
import { chromium } from 'playwright';

const port = 3000;

// Warm up Chrome on startup to trigger first-run dialogs
// This prevents the dialog from appearing during actual meetings
async function warmupChrome() {
  console.log('🔥 Warming up Chrome browser...');
  try {
    const browser = await chromium.launch({
      headless: false,
      executablePath: config.chromeExecutablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    console.log('Chrome opened, waiting 10 seconds to trigger first-run dialogs...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    await browser.close();
    console.log('✓ Chrome warmup complete - first-run dialogs triggered');
  } catch (error) {
    console.error('Chrome warmup failed (non-fatal):', error);
  }
}

// Create Express server
const server = http.createServer(app);

// Warm up Chrome before starting server
warmupChrome().then(() => {
  server.listen(port, () => {
    console.log(`🚀 Server is running on http://localhost:${port}`);
  });
}).catch(err => {
  console.error('Failed to warm up Chrome, starting server anyway:', err);
  server.listen(port, () => {
    console.log(`🚀 Server is running on http://localhost:${port}`);
  });
});

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
