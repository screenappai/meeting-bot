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
- **RESTful API**: Simple HTTP endpoints for easy integration
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

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_RECORDING_DURATION_MINUTES` | Maximum recording duration in minutes | `60` |
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment mode | `development` |

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
- ✅ API documentation
- 🔄 Recording Upload support - cloud bucket or a Docker volume (planned)
- 🔄 Additional platform support (planned)
- 🔄 Enhanced monitoring (planned)

---

**Note**: This project is for educational and legitimate automation purposes. Please ensure compliance with the terms of service of the platforms you're automating.
