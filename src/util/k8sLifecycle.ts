import * as fs from 'fs';
import * as https from 'https';
import axios from 'axios';
import { Logger } from 'winston';

// Reads the bot's own pod metadata via the in-cluster K8s API to detect whether the
// pod has already been marked for deletion before the container finished starting.
//
// Why this exists: when K8s sets a pod's deletionTimestamp while the container is still
// in ContainerCreating (e.g. HPA scale-down during slow image pull, or rollout colliding
// with an earlier deletion), kubelet sends SIGTERM to a not-yet-existing PID 1 and the
// signal is silently dropped. kubelet does NOT re-send SIGTERM after the container starts,
// so the bot then runs normally for the full terminationGracePeriodSeconds (3h) before
// being SIGKILLed — picking up Redis jobs the whole time. This helper lets the bot detect
// the situation at startup and trigger graceful shutdown itself.
//
// Fail-open: every error path returns false (proceed with normal startup). We only
// true-positive when we're certain.

const SA_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const SA_CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const K8S_API = 'https://kubernetes.default.svc';
const REQUEST_TIMEOUT_MS = 5000;

export async function isPodMarkedForDeletion(logger: Logger): Promise<boolean> {
  const podName = process.env.POD_NAME;
  const namespace = process.env.POD_NAMESPACE;

  if (!podName || !namespace) {
    logger.info('k8sLifecycle: skipping pod-deletion check (POD_NAME/POD_NAMESPACE not set — likely running outside K8s)');
    return false;
  }
  if (!fs.existsSync(SA_TOKEN_PATH)) {
    logger.info('k8sLifecycle: skipping pod-deletion check (no service account token mounted)');
    return false;
  }

  try {
    const token = fs.readFileSync(SA_TOKEN_PATH, 'utf-8').trim();
    const ca = fs.readFileSync(SA_CA_PATH);
    const url = `${K8S_API}/api/v1/namespaces/${namespace}/pods/${podName}`;

    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      httpsAgent: new https.Agent({ ca }),
      timeout: REQUEST_TIMEOUT_MS,
    });

    const deletionTimestamp = resp.data?.metadata?.deletionTimestamp;
    if (deletionTimestamp) {
      logger.warn('k8sLifecycle: pod is already marked for deletion at startup — will trigger graceful shutdown', {
        podName,
        namespace,
        deletionTimestamp,
        deletionGracePeriodSeconds: resp.data?.metadata?.deletionGracePeriodSeconds,
      });
      return true;
    }
    logger.info('k8sLifecycle: pod is not marked for deletion at startup', { podName, namespace });
    return false;
  } catch (err: any) {
    logger.warn('k8sLifecycle: pod-deletion check failed (non-fatal — continuing normal startup)', {
      error: err?.message || String(err),
      status: err?.response?.status,
    });
    return false; // fail open
  }
}
