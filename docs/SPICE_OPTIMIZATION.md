# SPICE Display Optimization Guide

This guide explains how to optimize SPICE display performance in infinivirt.

## Overview

SPICE (Simple Protocol for Independent Computing Environments) provides remote display capabilities with various optimization options. Infinivirt now supports all QEMU SPICE options for maximum performance tuning.

## Compression Options

### Image Compression

Controls how screen content is compressed before transmission:

- **auto_glz** (default): Automatic GLZ - Best balance for most scenarios
- **auto_lz**: Automatic LZ - Alternative auto mode
- **quic**: SFALIC algorithm - Fast compression, moderate bandwidth
- **glz**: LZ with global dictionary - High compression, more CPU usage
- **lz**: Lempel-Ziv - Moderate compression and CPU usage
- **off**: No compression - Highest bandwidth, lowest CPU

### WAN Compression

Additional compression for WAN scenarios:

- **jpeg-wan-compression**: JPEG compression (auto/never/always)
- **zlib-glz-wan-compression**: zlib-glz compression (auto/never/always)

## Streaming Video

Detects and optimizes video content:

- **filter** (default): Smart detection - Automatically detects video regions
- **all**: Treat all content as video - Lower quality, better performance
- **off**: Disable video streaming - Higher quality, more bandwidth

## Audio Compression

- **playback-compression**: CELT algorithm for audio (on/off, default: on)

## GL Acceleration

OpenGL acceleration for 3D applications:

- **gl**: Enable GL acceleration (requires recent QEMU/SPICE/Mesa)
- **rendernode**: Specify GPU render node (e.g., /dev/dri/renderD128)

**Note**: GL acceleration is currently local-only. Remote GL support is experimental.

## Resolution Adjustment

Automatic resolution adjustment requires:

1. **QXL VGA driver** (automatically configured by infinivirt)
2. **SPICE vdagent** running in guest OS
3. **SPICE client** that supports resolution changes (virt-viewer, remote-viewer)

### Guest Setup

#### Linux
```bash
# Debian/Ubuntu
sudo apt install spice-vdagent
sudo systemctl enable --now spice-vdagent

# RHEL/Fedora
sudo dnf install spice-vdagent
sudo systemctl enable --now spice-vdagentd
```

#### Windows
Download and install SPICE Guest Tools from:
https://www.spice-space.org/download.html

### QXL Memory Sizing

For high-resolution displays, increase QXL video memory:

| Resolution | Recommended QXL Memory |
|-----------|----------------------|
| 1920x1080 | 16 MB (default) |
| 2560x1440 | 32 MB |
| 3840x2160 (4K) | 64 MB |
| Multiple 4K | 128 MB |

## Performance Scenarios

### General Purpose (Default)
```typescript
const config = new SpiceConfig({
  port: 5901,
  imageCompression: 'auto_glz',
  streamingVideo: 'filter',
  playbackCompression: 'on'
})
```

### High-Bandwidth LAN
```typescript
const config = new SpiceConfig({
  port: 5901,
  imageCompression: 'off',
  streamingVideo: 'off'
})
```

### Low-Bandwidth WAN
```typescript
const config = new SpiceConfig({
  port: 5901,
  imageCompression: 'glz',
  jpegWanCompression: 'always',
  zlibGlzWanCompression: 'always',
  streamingVideo: 'all'
})
```

### 3D Workloads (Local)
```typescript
const config = new SpiceConfig({
  port: 5901,
  gl: true,
  rendernode: '/dev/dri/renderD128'
})
```

## Troubleshooting

### Resolution Not Adjusting

1. Verify vdagent is running in guest:
   ```bash
   # Linux
   systemctl status spice-vdagent

   # Windows
   Check "SPICE Agent" service in Services
   ```

2. Check SPICE client supports resolution changes (virt-viewer, remote-viewer)

3. Verify QXL driver is loaded in guest:
   ```bash
   # Linux
   lsmod | grep qxl
   ```

### Poor Performance

1. Check compression settings match network conditions
2. For LAN, try `imageCompression: 'off'`
3. For WAN, try `imageCompression: 'glz'` with WAN compression enabled
4. Monitor CPU usage - high compression uses more CPU

### GL Acceleration Not Working

1. Verify QEMU version supports GL (4.0+)
2. Check Mesa/DRI drivers are installed
3. Verify rendernode exists: `ls -l /dev/dri/`
4. GL is currently local-only, won't work over network

## Performance Impact Summary

| Option | CPU Impact | Bandwidth Impact | Use Case |
|--------|-----------|------------------|----------|
| auto_glz | Medium | Low | General purpose (default) |
| quic | Low | Medium | Fast networks, low CPU |
| glz | High | Very Low | Slow networks, powerful CPU |
| off | Very Low | Very High | LAN with high bandwidth |
| streaming=filter | Medium | Low | Mixed content (default) |
| streaming=all | Low | Very Low | Video-heavy workloads |
| gl=on | Low (GPU) | Medium | 3D applications (local) |

## References

- [QEMU SPICE Documentation](https://www.qemu.org/docs/master/system/devices/spice.html)
- [SPICE Protocol](https://www.spice-space.org/)
- [QXL Driver](https://www.spice-space.org/qxl.html)
