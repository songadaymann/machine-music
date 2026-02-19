#!/bin/bash
set -e

echo "[stream] SynthMob streamer starting..."
echo "[stream] APP_URL:      $APP_URL"
echo "[stream] RTMP_URL:     ${RTMP_URL:0:40}..."
echo "[stream] RESOLUTION:   $RESOLUTION"
echo "[stream] FRAMERATE:    $FRAMERATE"
echo "[stream] VIDEO_BITRATE: $VIDEO_BITRATE"
echo "[stream] AUDIO_BITRATE: $AUDIO_BITRATE"

# Parse resolution into width/height for Chrome
WIDTH=$(echo "$RESOLUTION" | cut -d'x' -f1)
HEIGHT=$(echo "$RESOLUTION" | cut -d'x' -f2)

# Ensure PulseAudio socket directory exists
mkdir -p /tmp/pulse

# Start all services via supervisor
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/synthmob-stream.conf
