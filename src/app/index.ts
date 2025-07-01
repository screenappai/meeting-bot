import express from 'express';
import client from 'prom-client';
import { NODE_ENV } from '../config';
import mainDebug from '../test/debug';
import googleRouter from './google';
import microsoftRouter from './microsoft';
import zoomRouter from './zoom';
import { globalJobStore } from '../lib/globalJobStore';

const app = express();

app.use(express.json());

let isbusy = 0;
let gracefulShutdown = 0;

app.get('/isbusy', async (req, res) => {
  // Use the job store's isBusy status
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  return res.status(200).json({ success: true, data: jobStoreBusy });
});

app.get('/health', async (req, res) => {
  // Simple health check endpoint for Docker
  return res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Create a Gauge metric for busy status (0 or 1)
const busyStatus = new client.Gauge({
  name: 'isbusy',
  help: 'busy status of the pod (1 = busy, 0 = available)'
});

const isavailable = new client.Gauge({
  name: 'isavailable',
  help: 'available status of the pod (1 = available, 0 = busy)'
});

app.get('/metrics', async (req, res) => {
  // Use the job store's isBusy status for metrics
  const jobStoreBusy = globalJobStore.isBusy() ? 1 : 0;
  busyStatus.set(jobStoreBusy);
  isavailable.set(1 - jobStoreBusy);
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

app.get('/debug', async (req, res, next) => {
  if (NODE_ENV === 'development') {
    next();
  }
  else {
    res.status(500).send({});
  }
}, async (req, res) => {
  await mainDebug('baf14', 'https://www.github.com');
  res.status(200).send({});
});

app.use('/google', googleRouter);
app.use('/microsoft', microsoftRouter);
app.use('/zoom', zoomRouter);

export const setGracefulShutdown = (val: number) =>
  gracefulShutdown = val;

export const getGracefulShutdown = () => gracefulShutdown;

export const setIsBusy = (val: number) =>
  isbusy = val;

export const getIsBusy = () => isbusy;

// This is endpoint start
// const main = async () => {
//   console.log('Running main loop...');

  
//   while (true) {
//     isbusy = 0;
//     if (content && content.element) {
//       const { bearerToken, url, name, teamId, timezone, userId, provider, eventId, botId } = JSON.parse(content.element) as BotLaunchParams;
//       const correlationId = createCorrelationId({ teamId, userId, botId, eventId, url });
//       const logger = loggerFactory(correlationId, provider);
//       logger.info(content.element);
      
//       try {
//         logger.info('LogBasedMetric Bot has started recording meeting.');
//         await joinMeetWithRetry(bearerToken, url, name, teamId, timezone, userId, provider, 0, eventId, botId, logger);
//         logger.info('LogBasedMetric Bot has finished recording meeting successfully.');
//       } catch (error) {
//         const errorType = getErrorType(error);
//         if (error instanceof KnownError) {
//           logger.error('KnownError bot is permanently exiting:', { error, teamId, userId });
//         } else {
//           logger.error('Error joining meeting after multiple retries on team:', { error, teamId, userId });
//         }
//         logger.error(`LogBasedMetric Bot has permanently failed. [errorType: ${errorType}]`);
//       }
//     }
//     if (gracefulShutdown) {
//       console.log('Exiting from main loop...');
//       gracefulShutdownApp();
//       break;
//     }
//   }
// };

export default app;
