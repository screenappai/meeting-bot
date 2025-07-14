# ARM Debugging Guide for Meeting Bot

## Common ARM Issues and Solutions

### 1. **Chrome/Chromium Compatibility Issues**

**Problem**: Google Chrome may not be available or compatible on ARM64
**Solution**: Use Chromium instead, which has better ARM support

```bash
# Test Chrome installation
docker run --rm --platform linux/arm64 your-image bash -c "
which google-chrome && google-chrome --version || echo 'Chrome not found'
which chromium && chromium --version || echo 'Chromium not found'
"
```

### 2. **Playwright Browser Compatibility**

**Problem**: Playwright may not have ARM-compatible browser binaries
**Solution**: Install only Chromium browser for ARM

```bash
# Install only Chromium for ARM
npx playwright install chromium --with-deps
```

### 3. **Graphics/Display Issues**

**Problem**: ARM may have different graphics drivers and libraries
**Solution**: Install ARM-specific graphics packages

```dockerfile
# ARM-specific graphics packages
libgles2 \
libegl1 \
libwayland-egl1 \
```

### 4. **System Library Dependencies**

**Problem**: Some libraries may be missing or incompatible on ARM
**Solution**: Check library dependencies

```bash
# Check library dependencies
ldd $(which chromium) 2>/dev/null || echo "Cannot check dependencies"
```

## Debugging Steps

### Step 1: Build and Test Debug Image

```bash
# Build debug image
docker build -f Dockerfile.debug -t meeting-bot:debug .

# Run debug tests
chmod +x test-arm-debug.sh
./test-arm-debug.sh
```

### Step 2: Check Specific Components

```bash
# Test Chrome/Chromium
docker run --rm --platform linux/arm64 meeting-bot:debug bash -c "
echo '=== Chrome Test ==='
which google-chrome && google-chrome --version || echo 'Chrome not found'
which chromium && chromium --version || echo 'Chromium not found'
"

# Test Playwright
docker run --rm --platform linux/arm64 meeting-bot:debug bash -c "
echo '=== Playwright Test ==='
npx playwright --version
ls -la ~/.cache/ms-playwright/ 2>/dev/null || echo 'No browsers found'
"

# Test Xvfb
docker run --rm --platform linux/arm64 meeting-bot:debug bash -c "
echo '=== Xvfb Test ==='
which Xvfb && Xvfb -version || echo 'Xvfb not found'
"
```

### Step 3: Test Application Startup

```bash
# Test application startup with timeout
docker run --rm --platform linux/arm64 -p 3000:3000 meeting-bot:debug timeout 30s node dist/index.js
```

### Step 4: Check Logs and Errors

```bash
# Run with detailed logging
docker run --rm --platform linux/arm64 -p 3000:3000 meeting-bot:debug bash -c "
export DEBUG=*
node dist/index.js
"
```

## Common Error Patterns

### 1. **"No such file or directory" errors**
- Check if ARM-specific libraries are missing
- Verify file paths and permissions

### 2. **"Illegal instruction" errors**
- Indicates CPU instruction set incompatibility
- May need to use different base image or compiler flags

### 3. **"Segmentation fault" errors**
- Often related to graphics/display libraries
- Check if Xvfb is working properly

### 4. **Browser launch failures**
- Chrome/Chromium may not be compatible
- Try using different browser or browser arguments

## ARM-Specific Optimizations

### 1. **Use ARM-Optimized Base Image**
```dockerfile
FROM --platform=linux/arm64 node:18
```

### 2. **Install ARM-Specific Packages**
```dockerfile
# ARM-specific graphics packages
libgles2 \
libegl1 \
libwayland-egl1 \
```

### 3. **Use Chromium Instead of Chrome**
```dockerfile
# Install Chromium for ARM
RUN apt-get install -y chromium
RUN ln -sf /usr/bin/chromium /usr/bin/google-chrome
```

### 4. **Optimize Playwright Installation**
```dockerfile
# Install only Chromium browser
RUN npx playwright install chromium --with-deps
```

## Testing Strategy

### 1. **Component Testing**
- Test each component individually
- Check browser compatibility
- Verify graphics libraries

### 2. **Integration Testing**
- Test full application startup
- Check all endpoints work
- Verify recording functionality

### 3. **Performance Testing**
- Monitor resource usage on ARM
- Check for memory leaks
- Verify CPU usage patterns

## Troubleshooting Commands

```bash
# Check architecture
dpkg --print-architecture

# Check Node.js version
node --version

# Check Chrome/Chromium
which google-chrome && google-chrome --version
which chromium && chromium --version

# Check Playwright browsers
ls -la ~/.cache/ms-playwright/

# Check system libraries
ldd $(which chromium)

# Check running processes
ps aux

# Check system resources
top -n 1

# Check network connectivity
curl -I http://localhost:3000/health
```

## Next Steps

1. **Run the debug script** to identify specific issues
2. **Check component compatibility** one by one
3. **Test with ARM-specific Dockerfile** if needed
4. **Monitor logs** for specific error messages
5. **Compare behavior** between x86_64 and ARM64 


# Notes for debugging

Key Differences in ARM Dockerfile:
Uses Chromium instead of Google Chrome
Installs ARM-specific graphics packages (libgles2, libegl1, libwayland-egl1)
Creates symlink for Playwright compatibility
Installs only Chromium browser for Playwright

Common Error Patterns to Look For:
"No such file or directory" - Missing ARM libraries
"Illegal instruction" - CPU instruction set incompatibility
"Segmentation fault" - Graphics library issues
Browser launch failures - Chrome/Chromium compatibility issues


Next Steps:
Run the debug script to identify specific issues
Check if Chromium works better than Chrome on ARM
Verify Playwright browser compatibility
Test the ARM-specific Dockerfile
Monitor logs for specific error messages
The ARM-specific Dockerfile (Dockerfile.arm) is likely to work better than your current setup because it:
Uses Chromium (more ARM-compatible than Chrome)
Installs ARM-specific graphics libraries
Optimizes Playwright for ARM architecture



# Quick Debugging Steps:

## Test Chrome/Chromium installation:
docker run --rm --platform linux/arm64 node:18 bash -c "
apt-get update && apt-get install -y chromium && chromium --version
"

## Test Playwright on ARM:
docker run --rm --platform linux/arm64 node:18 bash -c "
npm install playwright && npx playwright install chromium --with-deps
"

## Build and test the debug image:
docker build -f Dockerfile.debug -t meeting-bot:debug .
docker run --rm --platform linux/arm64 meeting-bot:debug

## Try the ARM-specific Dockerfile:
docker build -f Dockerfile.arm -t meeting-bot:arm .
docker run --rm --platform linux/arm64 meeting-bot:arm
