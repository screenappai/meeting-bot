# Meeting Bot 🤖

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-43853D?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)

An open-source automation bot for joining and recording video meetings across multiple platforms including Google Meet, Microsoft Teams, and Zoom. Built with TypeScript, Node.js, and Playwright for reliable browser automation.

## ✨ Features

- **Multi-Platform Support**: Join meetings on Google Meet, Microsoft Teams, and Zoom
- **Automated Recording**: Capture meeting recordings with configurable duration limits
- **Single Job Execution**: Ensures only one meeting is processed at a time across the entire system
- **Dual Integration Options**: RESTful API endpoints and Redis message queue for flexible integration
- **Asynchronous Processing**: Redis queue support for high-throughput, scalable meeting requests
- **Docker Support**: Containerized deployment with Docker and Docker Compose
- **Graceful Shutdown**: Proper cleanup and resource management
- **Prometheus Metrics**: Built-in monitoring and metrics collection
- **Stealth Mode**: Advanced browser automation with anti-detection measures

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ 
- Docker and Docker Compose (for containerized deployment)
- Git

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/screenappai/meeting-bot.git
   cd meeting-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Run with Docker (Recommended)**
   ```bash
   npm run dev
   ```

   Or run locally:
   ```bash
   npm start
   ```

The server will start on `http://localhost:3000`

## 📖 Usage

### How Meeting Bot Works

Meeting Bot operates with a single job execution model to ensure reliable meeting processing:

- **Single Job Processing**: Meeting Bot accepts only one job at a time and works until it's completely finished before accepting another job
- **Automatic Retry**: The bot automatically retries on certain errors such as automation failures or when it takes too long to admit the bot into a meeting

### API Endpoints


#### Join a Google Meet
```bash
POST /google/join
Content-Type: application/json

{
  "bearerToken": "your-auth-token",
  "url": "https://meet.google.com/abc-defg-hij",
  "name": "Meeting Notetaker",
  "teamId": "team123",
  "timezone": "UTC",
  "userId": "user123",
  "botId": "UUID"
}
```

#### Join a Microsoft Teams Meeting
```bash
POST /microsoft/join
Content-Type: application/json

{
  "bearerToken": "your-auth-token",
  "url": "https://teams.microsoft.com/l/meetup-join/...",
  "name": "Meeting Notetaker",
  "teamId": "team123",
  "timezone": "UTC",
  "userId": "user123",
  "botId": "UUID"
}
```

#### Join a Zoom Meeting
```bash
POST /zoom/join
Content-Type: application/json

{
  "bearerToken": "your-auth-token",
  "url": "https://zoom.us/j/123456789",
  "name": "Meeting Notetaker",
  "teamId": "team123",
  "timezone": "UTC",
  "userId": "user123",
  "botId": "UUID"
}
```

#### Check System Status
```bash
GET /isbusy
```

#### Get Metrics
```bash
GET /metrics
```


### Response Format

**Success Response (202 Accepted):**
```json
{
  "success": true,
  "message": "Meeting join request accepted and processing started",
  "data": {
    "userId": "user123",
    "teamId": "team123",
    "status": "processing"
  }
}
```

**Busy Response (409 Conflict):**
```json
{
  "success": false,
  "message": "System is currently busy processing another meeting",
  "error": "BUSY"
}
```


### Redis Message Queue (Alternative to REST API)

Meeting Bot also supports adding meeting join requests via Redis message queue, which provides asynchronous processing and better scalability for high-throughput scenarios.

#### Redis Message Structure

```typescript
interface MeetingJoinRedisParams {
  url: string;
  name: string;
  teamId: string;
  userId: string;
  bearerToken: string;
  timezone: string;
  botId?: string;
  eventId?: string;
  provider: 'google' | 'microsoft' | 'zoom';  // Required for Redis
}
```

#### Adding Messages to Redis Queue

**Using RPUSH (Recommended):**
```bash
# Connect to Redis and add a message to the queue
redis-cli RPUSH jobs:meetbot:list '{
  "url": "https://meet.google.com/abc-defg-hij",
  "name": "Meeting Notetaker",
  "teamId": "team123",
  "timezone": "UTC",
  "userId": "user123",
  "botId": "UUID",
  "provider": "google",
  "bearerToken": "your-auth-token"
}'
```

**Using Redis Client Libraries:**

**Node.js (ioredis):**
```javascript
import Redis from 'ioredis';

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: 'your-password'
});

const message = {
  url: "https://meet.google.com/abc-defg-hij",
  name: "Meeting Notetaker",
  teamId: "team123",
  timezone: "UTC",
  userId: "user123",
  botId: "UUID",
  provider: "google",
  bearerToken: "your-auth-token"
};

await redis.rpush('jobs:meetbot:list', JSON.stringify(message));
```

**Python (redis-py):**
```python
import redis
import json

r = redis.Redis(host='localhost', port=6379, password='your-password')

message = {
    "url": "https://meet.google.com/abc-defg-hij",
    "name": "Meeting Notetaker",
    "teamId": "team123",
    "timezone": "UTC",
    "userId": "user123",
    "botId": "UUID",
    "provider": "google",
    "bearerToken": "your-auth-token"
}

r.rpush('jobs:meetbot:list', json.dumps(message))
```

#### Queue Processing

- **FIFO Queue**: Messages are processed in First-In-First-Out order
- **BLPOP Processing**: The bot uses `BLPOP` to consume messages from the queue
- **Automatic Processing**: Messages are automatically picked up and processed by the Redis consumer service
- **Single Job Execution**: Only one meeting is processed at a time across the entire system

#### Redis Configuration

The following environment variables configure Redis connectivity:

| Variable | Description | Default |
|----------|-------------|---------|
| `REDIS_HOST` | Redis server hostname | `redis` |
| `REDIS_PORT` | Redis server port | `6379` |
| `REDIS_USERNAME` | Redis username (optional) | - |
| `REDIS_PASSWORD` | Redis password (optional) | - |
| `REDIS_QUEUE_NAME` | Queue name for meeting jobs | `jobs:meetbot:list` |
| `REDIS_CONSUMER_ENABLED` | Enable/disable Redis consumer service | `false` |

**Note**: When `REDIS_CONSUMER_ENABLED` is set to `false`, the Redis consumer service will not start, and the application will only support REST API endpoints for meeting requests. Redis message queue functionality will be disabled.

### Recording Upload Configuration

Meeting Bot automatically uploads meeting recording to S3-compatible bucket storage when a meeting end. This feature is enabled by default and supports various cloud storage providers:

- **AWS S3** - Amazon Web Services Simple Storage Service
- **GCP Cloud Storage** - Google Cloud Platform S3-compatible storage
- **MinIO** - Self-hosted S3-compatible object storage
- **Other S3-compatible services** - Any service that implements the S3 API

#### Environment Variables for Upload Configuration

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `S3_ENDPOINT` | S3-compatible service endpoint URL | - | Yes for non-AWS |
| `S3_ACCESS_KEY_ID` | Access key for bucket authentication | - | Yes |
| `S3_SECRET_ACCESS_KEY` | Secret key for bucket authentication | - | Yes |
| `S3_BUCKET_NAME` | Target bucket name for uploads | - | Yes |
| `S3_REGION` | AWS region (for AWS S3) | - | Yes |
| `S3_USE_MINIO_COMPATIBILITY` | Enable MinIO compatibility mode | `false` | No |

#### Configuration Examples

**AWS S3:**
```bash
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_BUCKET_NAME=meeting-recordings
S3_REGION=us-west-2
```

**Google Cloud Storage (S3-compatible):**
```bash
S3_ENDPOINT=https://storage.googleapis.com
S3_ACCESS_KEY_ID=your-gcp-access-key
S3_SECRET_ACCESS_KEY=your-gcp-secret-key
S3_BUCKET_NAME=meeting-recordings
S3_REGION=us-west1
```

**MinIO:**
```bash
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET_NAME=meeting-recordings
S3_REGION=us-west-2
S3_USE_MINIO_COMPATIBILITY=true
```

#### How Upload Works

1. **Automatic Upload**: When a meeting recording completes, the bot automatically uploads the file to the configured S3-compatible bucket
2. **File Naming**: Recordings are uploaded with descriptive names including meeting details and timestamps
3. **Error Handling**: If upload fails, the bot will automatically retry upload
4. **Cleanup**: Local recording files are cleaned up after successful upload

**Note**: The upload feature is enabled by default when S3 environment variables are configured. No additional configuration is required.

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_RECORDING_DURATION_MINUTES` | Maximum recording duration in minutes | `180` |
| `MEETING_INACTIVITY_MINUTES` | Continuous inactivity duration after which the bot will end meeting recording | `1` |
| `INACTIVITY_DETECTION_START_DELAY_MINUTES` | Initial grace period at the start of recording before inactivity detection begins | `1` |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment mode | `development` |
| `UPLOADER_FILE_EXTENSION` | Final recording file extension (e.g., .mkv, .webm) | `.webm` |
| `REDIS_HOST` | Redis server hostname | `redis` |
| `REDIS_PORT` | Redis server port | `6379` |
| `REDIS_USERNAME` | Redis username (optional) | - |
| `REDIS_PASSWORD` | Redis password (optional) | - |
| `REDIS_QUEUE_NAME` | Queue name for meeting jobs | `jobs:meetbot:list` |
| `REDIS_CONSUMER_ENABLED` | Enable/disable Redis consumer service | `false` |
| `S3_ENDPOINT` | S3-compatible service endpoint URL | - |
| `S3_ACCESS_KEY_ID` | Access key for bucket authentication | - |
| `S3_SECRET_ACCESS_KEY` | Secret key for bucket authentication | - |
| `S3_BUCKET_NAME` | Target bucket name for uploads | - |
| `S3_REGION` | AWS region (for AWS S3) | - |
| `S3_USE_MINIO_COMPATIBILITY` | Enable MinIO compatibility mode | `false` |

### Docker Configuration

The project includes Docker support with separate configurations for development and production:

- `Dockerfile` - Development build with hot reload
- `Dockerfile.production` - Optimized production build
- `docker-compose.yml` - Complete development environment

#### Using Docker Image from GitHub Packages

The project automatically builds and publishes Docker images to GitHub Packages on every push to the main branch.

**Pull the latest image:**
```bash
docker pull ghcr.io/screenappai/meeting-bot:latest
```

**Run the container:**
```bash
docker run -d \
  --name meeting-bot \
  -p 3000:3000 \
  -e MAX_RECORDING_DURATION_MINUTES=60 \
  -e NODE_ENV=production \
  -e REDIS_CONSUMER_ENABLED=false \
  -e S3_ENDPOINT= \
  -e S3_ACCESS_KEY_ID= \
  -e S3_SECRET_ACCESS_KEY= \
  -e S3_BUCKET_NAME= \
  -e S3_REGION= \
  ghcr.io/screenappai/meeting-bot:latest
```

**Available tags:**
- `latest` - Latest stable release from main branch
- `main` - Latest commit from main branch
- `sha-<commit-hash>` - Specific commit builds

## 🏗️ Architecture

```
src/
├── app/           # Express application and route handlers
├── bots/          # Platform-specific bot implementations
├── connect/       # Redis message broker and consumer services
├── lib/           # Core libraries and utilities
├── middleware/    # Express middleware
├── services/      # Business logic services
├── tasks/         # Background task implementations
├── types/         # TypeScript type definitions
└── util/          # Utility functions
```

### Key Components

- **AbstractMeetBot**: Base class for all platform bots
- **JobStore**: Manages single job execution across the system
- **RecordingTask**: Handles meeting recording functionality
- **ContextBridgeTask**: Manages browser context and automation
- **RedisMessageBroker**: Handles Redis queue operations (RPUSH/BLPOP)
- **RedisConsumerService**: Processes messages from Redis queue asynchronously

## ⚠️ Limitations

### Meeting Join Requirements

Meeting Bot supports joining meetings where users can join with a direct link without requiring authentication. The following scenarios are **not supported**:

- **Sign-in Required**: Meetings that require users to sign in to the platform (Google, Microsoft, Zoom) before joining
- **Enterprise Authentication**: Meetings that require enterprise SSO or domain-specific authentication
- **Password Protected**: Meetings that require a password in addition to the meeting link
- **Waiting Room with Authentication**: Meetings where the waiting room requires user identification or authentication

**Supported Scenarios:**
- ✅ Public meeting links that allow direct join
- ✅ Meetings with waiting rooms that don't require authentication
- ✅ Meetings where the bot can join as a guest/anonymous participant

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on how to:

- Set up your development environment
- Submit bug reports and feature requests
- Contribute code changes
- Follow our coding standards

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

**🎯 Primary Support Channel:**
- **Discord**: [Join our Discord Community](https://discord.gg/frS8QgUygn) - Our main forum for discussions, support, and real-time collaboration

**📋 Additional Resources:**
- **Issues**: [GitHub Issues](https://github.com/screenappai/meeting-bot/issues) - For bug reports and feature requests
- **Documentation**: [Wiki](https://github.com/screenappai/meeting-bot/wiki) - Detailed documentation and guides

## 🙏 Acknowledgments

- Built with [Playwright](https://playwright.dev/) for reliable browser automation
- Uses [Express.js](https://expressjs.com/) for the web server
- Containerized with [Docker](https://www.docker.com/)

## 📊 Project Status

- ✅ Google Meet support
- ✅ Microsoft Teams support  
- ✅ Zoom support
- ✅ Recording functionality
- ✅ Docker deployment
- ✅ REST API support
- ✅ Redis message queue support
- ✅ Recording Upload support - S3-compatible bucket storage (AWS, GCP, MinIO)
- 🔄 Additional video format support (planned)
- 🔄 Enhanced platform feature support (planned)

---

**Note**: This project is for educational and legitimate automation purposes. Please ensure compliance with the terms of service of the platforms you're automating.
