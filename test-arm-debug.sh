#!/bin/bash

echo "=== ARM Debug Test Script ==="
echo "Testing Docker image on ARM architecture..."

# Build the debug image
echo "Building debug Docker image..."
docker build -f Dockerfile.debug -t meeting-bot:debug .

# Test basic container startup
echo "Testing basic container startup..."
docker run --rm --platform linux/arm64 meeting-bot:debug echo "Container startup test passed"

# Test Chrome/Chromium installation
echo "Testing Chrome/Chromium installation..."
docker run --rm --platform linux/arm64 meeting-bot:debug bash -c "
echo 'Chrome/Chromium test:'
which google-chrome && google-chrome --version || echo 'Google Chrome not found'
which chromium && chromium --version || echo 'Chromium not found'
"

# Test Playwright browsers
echo "Testing Playwright browsers..."
docker run --rm --platform linux/arm64 meeting-bot:debug bash -c "
echo 'Playwright browsers:'
ls -la ~/.cache/ms-playwright/ 2>/dev/null || echo 'No Playwright browsers found'
npx playwright --version
"

# Test Xvfb
echo "Testing Xvfb..."
docker run --rm --platform linux/arm64 meeting-bot:debug bash -c "
echo 'Xvfb test:'
which Xvfb && Xvfb -version || echo 'Xvfb not found'
"

# Test application startup
echo "Testing application startup..."
docker run --rm --platform linux/arm64 -p 3000:3000 meeting-bot:debug timeout 30s node dist/index.js || echo "Application startup test completed"

echo "=== Debug test completed ===" 