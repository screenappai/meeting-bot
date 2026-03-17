# Meeting Bot Controller

A Python-based controller service that manages the lifecycle of meeting recordings for the Meeting Bot platform.

## Overview

The controller runs as a long-lived Kubernetes deployment (or standalone process) and continuously polls
Firestore for queued work. For each queued item it creates a Kubernetes Job that runs the `manager`
(plus the `meeting-bot` sidecar) to join and record the meeting.

High-level workflow:

1. **Discover meetings**: Finds meetings that need a bot deployed
2. **Enqueue**: Creates/links a `bot_instances` document for the meeting (`status=queued`)
3. **Claim**: Atomically claims a queued bot instance (best-effort distributed lock)
4. **Spawn Job**: Creates a Kubernetes Job for the meeting
5. **Mark Result**: Marks the bot instance as `done` / `failed` based on job creation result

## Architecture

- **Deployment**: Kubernetes Job in a pod with the main meeting-bot service
- **Triggering**: Polls Firestore (no Pub/Sub / KEDA required)
- **Language**: Python 3.11
- **Dependencies**: ffmpeg for media conversion, GCP client libraries

## Components

### Main Application (`main.py`)

Orchestrates the entire workflow and coordinates between components.

### Firestore Poller

- Queries Firestore for queued bot instances
- Uses a transaction to claim a bot instance
- Translates the Firestore document to the job payload the manager expects

### Meeting Monitor (`meeting_monitor.py`)

- Calls meeting-bot API to join meetings
- Polls job status every 10 seconds
- Detects meeting completion and retrieves recording path

### Media Converter (`media_converter.py`)

- Converts recordings to MP4 using H.264 codec
- Extracts audio as M4A
- Uses ffmpeg for all conversions

### Storage Client (`storage_client.py`)

- Uploads files to Google Cloud Storage
- Handles file metadata and content types
- Manages GCS paths from message data

## Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `GCP_PROJECT_ID` | **Yes** | Google Cloud Project ID | - |
| `GCS_BUCKET` | **Yes** | Google Cloud Storage bucket name | - |
| `MANAGER_IMAGE` | **Yes** | Docker image for the manager container | - |
| `MEETING_BOT_IMAGE` | **Yes** | Docker image for the meeting-bot container | - |
| `FIRESTORE_DATABASE` | No | Firestore database id | `(default)` |
| `KUBERNETES_NAMESPACE` | No | Kubernetes namespace to spawn jobs in | `default` |
| `JOB_SERVICE_ACCOUNT` | No | Service account for the spawned jobs | `meeting-bot-job` |
| `JOB_GCP_ADC_SECRET_NAME` | No | Secret name to mount into spawned job pods for ADC external-account JSON | unset |
| `JOB_GOOGLE_APPLICATION_CREDENTIALS` | No | Path set in spawned job pods for ADC credentials file | `/var/run/secrets/google/adc.json` |
| `JOB_USE_AZURE_WORKLOAD_IDENTITY` | No | Adds `azure.workload.identity/use=true` label to spawned job pods | `false` |
| `POLL_INTERVAL` | No | Seconds to wait between Firestore polls when no work | `10` |
| `MAX_CLAIM_PER_POLL` | No | Max queued items to claim per poll loop | `10` |
| `CLAIM_TTL_SECONDS` | No | Claim expiry; allows reprocessing if controller dies mid-claim | `600` |
| `ORPHANED_SESSION_VALIDATION_LIMIT` | No | Max claimed/processing meeting sessions checked per poll for missing K8s jobs | `50` |
| `ORPHANED_SESSION_REMEDIATION_ENABLED` | No | Whether to auto-remediate orphaned sessions detected with no active K8s job | `true` |
| `ORPHANED_SESSION_REMEDIATION_ACTION` | No | Remediation action for orphaned sessions: `requeue` or `failed` | `requeue` |
| `ORPHANED_SESSION_REMEDIATION_MIN_AGE_MINUTES` | No | Minimum orphaned age before remediation is applied | `ceil(CLAIM_TTL_SECONDS/60)` |
| `ORPHANED_SESSION_REMEDIATION_MAX_PER_CYCLE` | No | Max orphaned sessions remediated in a single poll cycle | `MAX_CLAIM_PER_POLL` |
| `MEETINGS_COLLECTION_PATH` | No | Where to discover meetings | `meetings` |
| `MEETINGS_QUERY_MODE` | No | `collection` or `collection_group` | `collection` |
| `MEETING_STATUS_FIELD` | No | Meeting status field name | `status` |
| `MEETING_STATUS_VALUES` | No | Comma-separated statuses to treat as needing a bot | `scheduled` |
| `MEETING_BOT_INSTANCE_FIELD` | No | Meeting field used to store bot instance id | `bot_instance_id` |
| `BOT_INSTANCE_STATUS_FIELD` | No | Bot instance status field name | `status` |
| `BOT_INSTANCE_QUEUED_VALUE` | No | Value for queued status | `queued` |
| `BOT_INSTANCE_PROCESSING_VALUE` | No | Value for processing status | `processing` |
| `BOT_INSTANCE_DONE_VALUE` | No | Value for done status | `done` |
| `BOT_INSTANCE_FAILED_VALUE` | No | Value for failed status | `failed` |
| `NODE_ENV` | No | Node environment for meeting-bot | `development` |
| `MAX_RECORDING_DURATION_MINUTES` | No | Max duration for recording | `600` |
| `MEETING_INACTIVITY_MINUTES` | No | Inactivity timeout | `15` |
| `INACTIVITY_DETECTION_START_DELAY_MINUTES` | No | Delay before inactivity detection starts | `5` |
| `GCP_DEFAULT_REGION` | No | GCP Region for meeting-bot config | `us-central1` |
| `SCRATCH_STORAGE_SIZE` | No | Size of scratch PVC for temp files | `50Gi` |
| `MEETING_BOT_CPU_REQUEST` | No | CPU request for meeting-bot container | `3000m` |
| `MEETING_BOT_MEMORY_REQUEST` | No | Memory request for meeting-bot container | `2Gi` |
| `MEETING_BOT_EPHEMERAL_STORAGE_REQUEST` | No | Ephemeral storage request for meeting-bot container | `8Gi` |
| `MEETING_BOT_CPU_LIMIT` | No | CPU limit for meeting-bot container | `4000m` |
| `MEETING_BOT_MEMORY_LIMIT` | No | Memory limit for meeting-bot container | `3Gi` |
| `MEETING_BOT_EPHEMERAL_STORAGE_LIMIT` | No | Ephemeral storage limit for meeting-bot container | `8Gi` |
| `MANAGER_CPU_REQUEST` | No | CPU request for manager container | `2500m` |
| `MANAGER_MEMORY_REQUEST` | No | Memory request for manager container | `4Gi` |
| `MANAGER_EPHEMERAL_STORAGE_REQUEST` | No | Ephemeral storage request for manager container | `2Gi` |
| `MANAGER_CPU_LIMIT` | No | CPU limit for manager container | `3750m` |
| `MANAGER_MEMORY_LIMIT` | No | Memory limit for manager container | `8Gi` |
| `MANAGER_EPHEMERAL_STORAGE_LIMIT` | No | Ephemeral storage limit for manager container | `2Gi` |
| `CONTROLLER_ID` | No | ID for this controller instance (for claiming) | `$HOSTNAME` or `controller` |

## Firestore data model

### Meetings (input)

The controller discovers meetings from the configured location:

- `MEETINGS_QUERY_MODE=collection` (default): uses `MEETINGS_COLLECTION_PATH` as a collection path.
- `MEETINGS_QUERY_MODE=collection_group`: uses `MEETINGS_COLLECTION_PATH` as a collection id.

Minimum fields expected on a meeting document:

- `meeting_url` (string)
- `status` (string) in `MEETING_STATUS_VALUES` (default: `scheduled`)

If the meeting already has `bot_instance_id` (configurable via `MEETING_BOT_INSTANCE_FIELD`), the controller will not enqueue a new bot.

### Bot instances (created by controller)

The controller creates documents in the top-level `bot_instances` collection.

Minimum fields on a queued bot instance document:

- `meeting_url` (string)
- `status` (string) = `queued`

Optional fields (forwarded into the job environment):

- `bot_name` (string)
- `creator_organization_id` (string)
- `creator_user_id` (string)
- `gcs_path` (string)

The controller will claim and update bot instance documents with:

- `status`: `processing` → `done` / `failed`
- `claimed_by`, `claimed_at`, `claim_expires_at`
- `processed_at`

## Output

Files are uploaded to GCS with the following structure:

```text
gs://{GCS_BUCKET}/{gcs_path}/video.mp4
gs://{GCS_BUCKET}/{gcs_path}/audio.m4a
```

## Building

### Docker Build

```bash
docker build -f Dockerfile.controller -t meeting-bot-controller .
```

### Local Development

```bash
cd controller
pip install -r requirements.txt
python main.py
```

## Deployment

The controller is automatically built and pushed to Google Artifact Registry via GitHub Actions:

- **Development**: Pushes to `australia-southeast1-docker.pkg.dev/aw-development-7226/meeting-bot-controller/controller`
- **Production**: Pushes to `australia-southeast1-docker.pkg.dev/aw-production-4df9/meeting-bot-controller/controller`

### Kubernetes Job Example

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: meeting-controller
spec:
  template:
    spec:
      containers:
      - name: controller
        image: australia-southeast1-docker.pkg.dev/aw-production-4df9/meeting-bot-controller/controller:latest
        env:
        - name: GCP_PROJECT_ID
          value: "your-project-id"
        - name: GCS_BUCKET
          value: "your-recordings-bucket"
        - name: MEETING_BOT_API_URL
          value: "http://meeting-bot-service:3000"
        - name: FIRESTORE_DATABASE
          value: "(default)"
      restartPolicy: OnFailure
```

## Notes on scaling

Because the controller now polls Firestore instead of consuming Pub/Sub, you can:

- run a single replica (simplest), or
- run multiple replicas with the claim/TTL mechanism preventing most double-processing.

## Error Handling

- Failed items are logged and marked as `failed` in Firestore
- Media conversion failures are logged with ffmpeg output
- API failures include retry logic in the monitoring loop
- All errors return non-zero exit codes for Kubernetes restart handling

## Logging

All components use Python's logging module with structured output:

- INFO: Normal workflow progress
- WARNING: Recoverable issues
- ERROR: Failed operations
- DEBUG: Detailed debugging information

## Performance

- **Conversion**: Uses ffmpeg with medium preset for balanced speed/quality
- **Monitoring**: 10-second polling interval (configurable)
- **Timeout**: 4-hour maximum wait time for meetings (configurable)

## Security

- Runs as non-root user (UID 1000)
- Credentials via GCP Workload Identity
- No secrets in environment variables
- Temporary files cleaned up after upload

## Future Enhancements

- Parallel conversion of MP4 and M4A
- Configurable video quality settings
- Support for additional audio formats
- Webhook notifications on completion
- Metrics and monitoring integration
