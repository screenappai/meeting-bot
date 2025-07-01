# Environment setup

- Use `MAX_RECORDING_DURATION_MINUTES` environment variable to set an upper limit on maximum recording duration

# Job Store

The application includes a simple in-memory job store that ensures only one meeting can be processed at a time across the entire container.

## Features

- **Single Job Execution**: Only one job can run at a time. New requests are rejected if a job is already running.
- **Immediate Response**: API endpoints return immediately after accepting a job, rather than waiting for completion.
- **Global Busy Status**: The `/isbusy` endpoint reflects the current job status.

## API Endpoints

- `POST /google/join` - Submit a new Google Meet join request
- `GET /isbusy` - Check if the system is currently processing a job
- `GET /metrics` - Prometheus metrics including busy status

## Usage

Submit a join request:
```bash
POST /google/join
{
  "bearerToken": "...",
  "url": "https://meet.google.com/...",
  "name": "Bot Name",
  "teamId": "team123",
  "timezone": "UTC",
  "userId": "user123"
}
```

Response (202 Accepted):
```json
{
  "success": true,
  "message": "Google Meet join request accepted and processing started",
  "data": {
    "userId": "user123",
    "teamId": "team123",
    "status": "processing"
  }
}
```

If another job is running, you'll get a 409 Conflict response.

# LICENSE

MIT
