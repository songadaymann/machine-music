# SynthMob Live Streamer

Headless browser container that captures SynthMob (Three.js + Strudel audio) and streams it 24/7 via RTMP to Twitch, YouTube, X, and more.

## How It Works

```
XVFB (virtual display)
  └── Chrome + SwiftShader (software WebGL)
       └── loads synthmob.fly.dev?autoplay=1
PulseAudio (virtual audio sink)
  └── captures Chrome's Web Audio output
FFmpeg
  └── captures display + audio → encodes H.264/AAC → pushes RTMP
```

No GPU required. Chrome's SwiftShader software renderer handles Three.js at 20-30 FPS — fine for streaming. The `?autoplay=1` parameter tells the client to start music automatically and hide the HUD for a clean stream.

## Quick Start

1. **Get an RTMP ingest URL.** Sign up at [Restream.io](https://restream.io) (~$16/mo) to stream to Twitch + YouTube + X simultaneously with a single RTMP stream. Or use a platform directly:
   - Twitch: `rtmp://live.twitch.tv/app/YOUR_STREAM_KEY`
   - YouTube: `rtmp://a.rtmp.youtube.com/live2/YOUR_STREAM_KEY`
   - X/Twitter: Get URL from Media Studio

2. **Set your RTMP URL** in `docker-compose.yml`:
   ```yaml
   - RTMP_URL=rtmp://live.restream.io/live/YOUR_STREAM_KEY
   ```

3. **Build and run:**
   ```bash
   cd streaming
   docker compose up -d
   ```

4. **Check health:**
   ```bash
   docker compose logs -f
   docker exec synthmob-streamer /healthcheck.sh
   ```

## Configuration

All config is via environment variables in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_URL` | `https://synthmob.fly.dev?autoplay=1` | URL to stream. Keep `?autoplay=1` for auto-start. |
| `RTMP_URL` | — | RTMP ingest URL with stream key |
| `RESOLUTION` | `1920x1080` | Stream resolution. Use `1280x720` to reduce CPU. |
| `FRAMERATE` | `30` | Frames per second |
| `VIDEO_BITRATE` | `4500k` | Video bitrate (4500k for 1080p, 2500k for 720p) |
| `AUDIO_BITRATE` | `128k` | Audio bitrate |

## Hosting Recommendations

This container needs **4+ vCPU and 4GB+ RAM** for 1080p/30fps streaming.

| Provider | Spec | Cost | Notes |
|----------|------|------|-------|
| **Hetzner CCX33** | 8 vCPU / 32GB | ~$40/mo | Best value, dedicated AMD cores |
| **Hetzner CPX31** | 4 vCPU / 8GB | ~$15/mo | Budget option, 720p recommended |
| **DigitalOcean** | 4 vCPU / 8GB | ~$48/mo | Simple setup |
| **Any VPS with Docker** | 4+ vCPU / 4GB+ | varies | Just needs Docker |

For 720p streaming (less CPU), set:
```yaml
- RESOLUTION=1280x720
- VIDEO_BITRATE=2500k
```

## Multi-Platform Streaming

**Recommended: [Restream.io](https://restream.io)** (~$16/mo)
- Send one RTMP stream → Restream distributes to 30+ platforms
- Connect Twitch, YouTube, X, TikTok, Facebook, etc.
- No extra bandwidth or CPU from your server

**Alternative: [api.video](https://api.video)** (API-first)
- Up to 5 restream destinations per live stream
- Fully API-driven

**Self-hosted: nginx-rtmp-module** (free, more bandwidth)
- Fan out RTMP with `push` directives
- Triples outbound bandwidth

## Troubleshooting

**Black screen / no video:**
- Chrome may not have loaded yet. FFmpeg waits 10s before starting (configured in supervisord.conf `startsecs`). Increase if your network is slow.

**No audio:**
- Check PulseAudio is running: `docker exec synthmob-streamer pactl list sinks`
- The `--autoplay-policy=no-user-gesture-required` Chrome flag should bypass autoplay restrictions.

**Low FPS / choppy:**
- Reduce resolution to 1280x720
- Reduce framerate to 24
- Ensure your VPS has 4+ dedicated (not shared) CPU cores

**Stream disconnects:**
- Supervisord auto-restarts all processes on crash
- Check logs: `docker compose logs -f`
- Health check runs every 30s

**Chrome crashes (OOM):**
- Increase `shm_size` in docker-compose.yml (default 2GB)
- Increase container memory limit
