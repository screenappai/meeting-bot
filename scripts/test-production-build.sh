#!/bin/bash

# Test production Docker build
set -e

echo "🧪 Testing production Docker build..."

# Build the production image
docker build -f Dockerfile.production -t meeting-bot:test .

echo "✅ Production image built successfully!"

# Test that the container starts without the xvfb-run-wrapper error
echo "🚀 Testing container startup..."

# Run the container in the background
CONTAINER_ID=$(docker run -d --name meeting-bot-test -p 3001:3000 meeting-bot:test)

# Wait a moment for the container to start
sleep 5

# Check if the container is running
if docker ps | grep -q meeting-bot-test; then
    echo "✅ Container started successfully!"
    
    # Test the health endpoint
    echo "🏥 Testing health endpoint..."
    if curl -f http://localhost:3001/health > /dev/null 2>&1; then
        echo "✅ Health endpoint is working!"
    else
        echo "❌ Health endpoint failed"
    fi
    
    # Clean up
    docker stop meeting-bot-test
    docker rm meeting-bot-test
    echo "🧹 Cleaned up test container"
else
    echo "❌ Container failed to start"
    docker logs meeting-bot-test
    docker stop meeting-bot-test 2>/dev/null || true
    docker rm meeting-bot-test 2>/dev/null || true
    exit 1
fi

echo "🎉 Production build test completed successfully!" 