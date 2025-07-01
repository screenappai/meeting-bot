import http from 'http';
import app, { setGracefulShutdown } from './app';
import { globalJobStore } from './lib/globalJobStore';

const port = 3000;

// Create Express server
const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
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
    console.log('Exiting.....');
    process.exit(0);
  });
};
