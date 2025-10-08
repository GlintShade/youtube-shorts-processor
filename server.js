const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json({ limit: '100mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'youtube-shorts-processor' });
});

// Download and process specific segment with OAUTH authentication
app.post('/process-segment', async (req, res) => {
  const { videoUrl, startTime, duration = 60, caption, cta } = req.body;
  
  if (!videoUrl || startTime === undefined) {
    return res.status(400).json({ error: 'videoUrl and startTime required' });
  }

  const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const downloadPath = `/tmp/${fileName}.mp4`;
  const outputPath = `/tmp/${fileName}_processed.mp4`;

  try {
    console.log(`Downloading segment: ${startTime}s for ${duration}s duration`);
    
    // Calculate end time
    const endTime = startTime + duration;
    
    // FIXED: Use oauth2 and android client to bypass 403 errors
    const ytDlpCommand = `yt-dlp \
      --username oauth2 \
      --password '' \
      -f "best[ext=mp4][height<=1080]/best[ext=mp4]/best" \
      --download-sections "*${startTime}-${endTime}" \
      --force-keyframes-at-cuts \
      -o "${downloadPath}" \
      "${videoUrl}"`;

    console.log('Executing yt-dlp command...');
    await execPromise(ytDlpCommand, { maxBuffer: 50 * 1024 * 1024 });
    
    console.log('Processing video with FFmpeg...');
    
    // Prepare text overlays
    const captionText = (caption || 'Amazing Content!').replace(/'/g, "'\\''");
    const ctaText = (cta || 'Follow for more!').replace(/'/g, "'\\''");
    
    // Process video: convert to vertical 9:16 with text overlays
    await execPromise(`ffmpeg -i "${downloadPath}" \
      -vf "scale=w=1080:h=ih*1080/iw:force_original_aspect_ratio=decrease,\
      pad=w=1080:h=1920:x=(ow-iw)/2:y=(oh-ih)/2:color=black,\
      drawtext=text='${captionText}':x=(w-text_w)/2:y=80:fontsize=52:fontcolor=white:\
      box=1:boxcolor=black@0.7:boxborderw=15,\
      drawtext=text='${ctaText}':x=(w-text_w)/2:y=h-150:fontsize=42:fontcolor=white:\
      box=1:boxcolor=red@0.8:boxborderw=12" \
      -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}" -y`);
    
    console.log('Reading processed video...');
    
    // Read file and return as base64
    const videoBuffer = await fs.readFile(outputPath);
    const base64Video = videoBuffer.toString('base64');
    
    // Cleanup
    await fs.unlink(downloadPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    
    res.json({
      success: true,
      video: base64Video,
      fileName: `${fileName}_processed.mp4`,
      size: videoBuffer.length,
      segment: {
        start: startTime,
        duration: duration
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
    
    // Cleanup on error
    try {
      await fs.unlink(downloadPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    } catch {}
    
    res.status(500).json({ 
      error: 'Processing failed', 
      details: error.message 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Shorts Processor running on port ${PORT}`);
});
