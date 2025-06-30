import { WaitPromise } from '../types';

export const getWaitingPromise = (waitMs: number): WaitPromise => {
  let promiseResolve: (value: void | PromiseLike<void>) => void;
  let timeout: NodeJS.Timeout;

  const promise = new Promise<void>((resolve) => {
    promiseResolve = resolve;
    timeout = setTimeout(() => {
      resolve();
    }, waitMs);
  });

  const resolveEarly = () => {
    clearTimeout(timeout);
    promiseResolve();
  };

  return { promise, resolveEarly };
};
