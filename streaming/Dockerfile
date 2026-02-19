FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV PULSE_SERVER=unix:/tmp/pulse/native

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    pulseaudio \
    ffmpeg \
    chromium-browser \
    fonts-liberation \
    fonts-noto-color-emoji \
    supervisor \
    curl \
    dbus \
    && rm -rf /var/lib/apt/lists/*

# PulseAudio config: run as daemon, use virtual sink
RUN mkdir -p /tmp/pulse && \
    echo "default-server = unix:/tmp/pulse/native" > /etc/pulse/client.conf && \
    echo "autospawn = no" >> /etc/pulse/client.conf

COPY pulse-default.pa /etc/pulse/default.pa
COPY supervisord.conf /etc/supervisor/conf.d/synthmob-stream.conf
COPY entrypoint.sh /entrypoint.sh
COPY healthcheck.sh /healthcheck.sh

RUN chmod +x /entrypoint.sh /healthcheck.sh

# Default config (override via env or docker-compose)
ENV APP_URL=https://synthmob.fly.dev?autoplay=1
ENV RTMP_URL=rtmp://live.restream.io/live/your-stream-key
ENV RESOLUTION=1920x1080
ENV FRAMERATE=30
ENV VIDEO_BITRATE=4500k
ENV AUDIO_BITRATE=128k

HEALTHCHECK --interval=30s --timeout=10s --retries=3 CMD /healthcheck.sh

ENTRYPOINT ["/entrypoint.sh"]
