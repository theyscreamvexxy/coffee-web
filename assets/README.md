# Assets — Hero Video

Place your video file here with the exact filename:

```
assets/hero-coffee-video.mp4
```

## Video Requirements

- **Filename:** `hero-coffee-video.mp4`
- **Format:** MP4 (H.264 for maximum browser compatibility)
- **Aspect ratio:** Recommended 16:9 or 2.39:1 (cinematic)
- **Resolution:** Minimum 1080p, preferably 4K for retina displays
- **Duration:** 8–20 seconds works best for scroll scrubbing
- **Content:** Coffee packet to coffee cup transformation

## What happens without the video

If the video is missing or fails to load, the page automatically
activates a **canvas fallback** — an ambient animated dark atmosphere
with glowing bokeh, steam lines, and floating particles that matches
the luxury aesthetic.

## Optimisation Tips

```bash
# Compress with ffmpeg for fast loading (optional)
ffmpeg -i original.mp4 -vcodec h264 -crf 23 -preset slow -movflags faststart assets/hero-coffee-video.mp4
```
