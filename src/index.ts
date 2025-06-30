import http from 'http';
import app, { setGracefulShutdown } from './app';
import { RedisMessageBroker } from './util/RedisMessageBroker';

const port = 3000;

// Create Express server
const server = http.createServer(app);

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received. Starting Graceful Shutdown');
  setGracefulShutdown(1);
});
process.on('SIGINT', () => {
  console.log('SIGINT signal received. Starting Graceful Shutdown');
  setGracefulShutdown(1);
});
process.on('SIGABRT', () => {
  console.log('SIGABRT signal received. Starting Graceful Shutdown');
  setGracefulShutdown(1);
});

export const gracefulShutdownApp = (messageBroker: RedisMessageBroker) => {
  // Complete existing requests, close database connections, etc.
  server.close(async () => {
    await messageBroker.quitClientGracefully();
    console.log('HTTP server closed. Exiting application');
    console.log('Exiting.....');
    process.exit(0);
  });
};
