# Deployment Guide

This guide explains how to deploy the Meeting Bot using Docker images built and published to GitHub Packages.

## 🚀 GitHub Actions Workflow

The project includes an automated GitHub Actions workflow that builds and publishes Docker images to GitHub Packages on every push to the main branch.

### Workflow Features

- **Automatic builds** on pushes to main branch
- **Pull request validation** (builds but doesn't push)
- **Multi-stage Docker builds** for optimized production images
- **Caching** for faster builds
- **Multiple tags** (latest, main, commit-specific)
- **Security** with non-root user in production

### Workflow File

The workflow is defined in `.github/workflows/docker-build.yml` and includes:

1. **Trigger**: Only runs on main branch pushes and PRs
2. **Build**: Uses `Dockerfile.production` for optimized builds
3. **Publish**: Pushes to `ghcr.io/screenappai/meeting-bot`
4. **Tags**: Creates multiple tags for versioning

## 📦 Docker Images

### Production Image (`Dockerfile.production`)

- **Base**: Node.js 18 Alpine
- **Multi-stage build** for smaller final image
- **Security**: Runs as non-root user
- **Optimized**: Only production dependencies
- **Health check**: Built-in health monitoring

### Development Image (`Dockerfile`)

- **Base**: Node.js 18
- **Full dependencies** for development
- **Hot reload** support
- **Debugging tools** included

## 🔧 Setup Instructions

### 1. Enable GitHub Packages

1. Go to your repository settings
2. Navigate to "Packages" section
3. Ensure "Inherit access from source repository" is enabled
4. Verify that the `GITHUB_TOKEN` secret is available (automatically provided)

### 2. Repository Configuration

The workflow uses these environment variables:
- `REGISTRY`: `ghcr.io` (GitHub Container Registry)
- `IMAGE_NAME`: `${{ github.repository }}` (your repo name)

### 3. First Deployment

1. Push your code to the main branch
2. The workflow will automatically trigger
3. Check the "Actions" tab to monitor the build
4. Once complete, your image will be available at:
   ```
   ghcr.io/screenappai/meeting-bot:latest
   ```

## 🐳 Using the Docker Image

### Pull the Image

```bash
docker pull ghcr.io/screenappai/meeting-bot:latest
```

### Run the Container

```bash
docker run -d \
  --name meeting-bot \
  -p 3000:3000 \
  -e MAX_RECORDING_DURATION_MINUTES=60 \
  -e NODE_ENV=production \
  -e GCP_DEFAULT_REGION=your-region \
  -e GCP_MISC_BUCKET=your-bucket \
  ghcr.io/screenappai/meeting-bot:latest
```

### Environment Variables

Required environment variables:
- `GCP_DEFAULT_REGION`: Your Google Cloud region
- `GCP_MISC_BUCKET`: Your Google Cloud Storage bucket

Optional environment variables:
- `MAX_RECORDING_DURATION_MINUTES`: Maximum recording duration (default: 180)
- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment mode (default: production)

### Docker Compose Example

```yaml
version: '3.8'
services:
  meeting-bot:
    image: ghcr.io/screenappai/meeting-bot:latest
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - GCP_DEFAULT_REGION=us-central1
      - GCP_MISC_BUCKET=your-meeting-recordings
      - MAX_RECORDING_DURATION_MINUTES=60
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## 🏷️ Image Tags

The workflow creates multiple tags:

- `latest`: Latest stable release from main branch
- `main`: Latest commit from main branch  
- `sha-<commit-hash>`: Specific commit builds

### Using Specific Tags

```bash
# Latest stable
docker pull ghcr.io/screenappai/meeting-bot:latest

# Latest from main branch
docker pull ghcr.io/screenappai/meeting-bot:main

# Specific commit
docker pull ghcr.io/screenappai/meeting-bot:sha-abc123
```

## 🔍 Monitoring and Health Checks

### Health Check Endpoint

The application provides a health check endpoint:

```bash
curl http://localhost:3000/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "uptime": 3600
}
```

### Docker Health Check

The production Docker image includes a built-in health check:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })" || exit 1
```

### Monitoring Endpoints

- `/health`: Application health status
- `/isbusy`: Current job processing status
- `/metrics`: Prometheus metrics

## 🔒 Security Considerations

### Production Image Security

- **Non-root user**: Application runs as `nodejs` user (UID 1001)
- **Minimal dependencies**: Only production packages included
- **Alpine base**: Smaller attack surface
- **No development tools**: Removed in production stage

### Access Control

- **GitHub Packages**: Private by default for private repositories
- **Authentication**: Uses `GITHUB_TOKEN` for secure access
- **Permissions**: Minimal required permissions for workflow

## 🛠️ Troubleshooting

### Common Issues

1. **Build failures**: Check GitHub Actions logs for detailed error messages
2. **Permission errors**: Ensure repository has package write permissions
3. **Image not found**: Verify the image name and tag are correct
4. **Health check failures**: Check application logs for startup issues

### Debug Commands

```bash
# Check container logs
docker logs meeting-bot

# Check container health
docker inspect meeting-bot | grep Health -A 10

# Test health endpoint
curl -v http://localhost:3000/health

# Check container status
docker ps -a
```

### Local Testing

Use the provided script to test the production build locally:

```bash
./scripts/build-production.sh
```

## 📈 Scaling Considerations

### Resource Requirements

- **Memory**: Minimum 2GB RAM recommended
- **CPU**: 2+ cores for optimal performance
- **Storage**: 10GB+ for recordings and temporary files
- **Network**: Stable internet connection for meeting platforms

### Horizontal Scaling

For high availability, consider:
- **Load balancer**: Distribute requests across multiple instances
- **Shared storage**: Use cloud storage for recordings
- **Database**: External database for job tracking
- **Monitoring**: Centralized logging and metrics

## 🔄 Updates and Rollbacks

### Updating the Application

1. Push changes to main branch
2. Wait for GitHub Actions to complete
3. Pull the new image: `docker pull ghcr.io/screenappai/meeting-bot:latest`
4. Restart containers with new image

### Rollback Strategy

1. Use specific commit tags for rollbacks
2. Keep previous images for quick rollback
3. Test new versions in staging environment
4. Use blue-green deployment for zero-downtime updates

## 🤝 Community and Support

### Getting Help

**🎯 Primary Support Channel:**
- **Discord**: [Join our Discord Community](https://discord.gg/yS62MZBH) - Our main forum for discussions, support, and real-time collaboration

**📋 Additional Resources:**
- **Issues**: [GitHub Issues](https://github.com/screenappai/meeting-bot/issues) - For bug reports and feature requests
- **Documentation**: Check the [README.md](README.md) and [Wiki](https://github.com/screenappai/meeting-bot/wiki) - For detailed guides and API documentation

### Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on how to get involved with the project. 