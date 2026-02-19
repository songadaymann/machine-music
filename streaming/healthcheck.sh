#!/bin/bash
# Health check: verify xvfb, chrome, and ffmpeg are running

XVFB_PID=$(pgrep -f "Xvfb :99" || true)
CHROME_PID=$(pgrep -f "chromium" || true)
FFMPEG_PID=$(pgrep -f "ffmpeg" || true)

if [ -z "$XVFB_PID" ]; then
    echo "UNHEALTHY: Xvfb not running"
    exit 1
fi

if [ -z "$CHROME_PID" ]; then
    echo "UNHEALTHY: Chrome not running"
    exit 1
fi

if [ -z "$FFMPEG_PID" ]; then
    echo "UNHEALTHY: FFmpeg not running"
    exit 1
fi

echo "HEALTHY: all processes running (xvfb=$XVFB_PID, chrome=$CHROME_PID, ffmpeg=$FFMPEG_PID)"
exit 0
