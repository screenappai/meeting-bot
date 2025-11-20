#!/bin/bash

export DISPLAY=:99

# Note: Playwright is installed during Docker build as root
# Browsers are in /root/.cache/ms-playwright/ which is readable by nodejs user
echo "✓ Using Playwright browsers from Docker image"

# Set up PulseAudio runtime directory
# For root user (local Docker), use /run/user/0
# For nodejs user (production), use /run/user/1001
USER_ID=$(id -u)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/${USER_ID}}
echo "Using XDG_RUNTIME_DIR: $XDG_RUNTIME_DIR"

# Create runtime directory if it doesn't exist
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# Kill any existing PulseAudio processes
pulseaudio --kill 2>/dev/null || true
sleep 1

# Start PulseAudio in user mode (simpler and more reliable)
pulseaudio -D --exit-idle-time=-1 --log-level=info 2>&1

# Wait for PulseAudio to fully initialize
sleep 5

# Verify PulseAudio is running
if pgrep -x "pulseaudio" > /dev/null; then
    echo "✓ PulseAudio is running (PID: $(pgrep -x pulseaudio))"

    # Load null sink module (virtual audio output device)
    SINK_ID=$(pactl load-module module-null-sink sink_name=virtual_output sink_properties=device.description="Virtual_Output" 2>&1)
    echo "✓ Loaded null sink module (ID: $SINK_ID)"

    # Set as default sink (Teams will play audio here)
    pactl set-default-sink virtual_output 2>&1
    echo "✓ Set virtual_output as default sink"

    # List available sinks and sources
    echo "=== Available PulseAudio sinks ==="
    pactl list sinks short
    echo "=== Available PulseAudio sources (monitors) ==="
    pactl list sources short

    # Show defaults
    echo "=== Defaults ==="
    pactl info | grep "Default Sink"

    # Verify monitor source exists for ffmpeg
    if pactl list sources short | grep -q "virtual_output.monitor"; then
        echo "✓ Monitor source virtual_output.monitor is available for ffmpeg"
    else
        echo "✗ WARNING: Monitor source not found!"
    fi
else
    echo "✗ ERROR: PulseAudio failed to start"
    ps aux | grep pulse
fi

xvfb-run --server-num=99 --server-args='-screen 0 1280x800x24' npm run start
