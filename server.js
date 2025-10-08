const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json({ limit: '10mb' }));

// Serve static files from /tmp directory
app.use('/downloads', express.static('/tmp'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'youtube-shorts-processor' });
});

// Initialize cookies
async function setupCookies() {
  const cookiesContent = process.env.YT_COOKIES;
  if (cookiesContent) {
    const cookiesPath = '/tmp/cookies.txt';
    await fs.writeFile(cookiesPath, cookiesContent, 'utf8');
    console.log('Cookies loaded');
    return cookiesPath;
  }
  return null;
}

let cookiesPath = null;
setupCookies().then(path => { cookiesPath = path; });

// Clean up old files (older than 10 minutes)
async function cleanupOldFiles() {
  try {
    const files = await fs.readdir('/tmp');
    const now = Date.now();
    
    for (const file of files) {
      if (file.endsWith('_processed.mp4')) {
        const filePath = `/tmp/${file}`;
        const stats = await fs.stat(filePath);
        const age = now - stats.mtimeMs;
        
        // Delete files older than 10 minutes
        if (age > 10 * 60 * 1000) {
          await fs.unlink(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      }
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupOldFiles, 5 * 60 * 1000);

// Download and process segment
app.post('/process-segment', async (req, res) => {
  const { videoUrl, startTime, duration = 60, caption, cta } = req.body;
  
  if (!videoUrl || startTime === undefined) {
    return res.status(400).json({ error: 'videoUrl and startTime required' });
  }

  const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const rawDownloadPath = `/tmp/${fileName}_raw.mp4`;
  const outputPath = `/tmp/${fileName}_processed.mp4`;

  try {
    console.log(`Step 1: Downloading segment at ${startTime}s`);
    
    // Download segment
    let ytDlpCommand = `yt-dlp \
      --extractor-args "youtube:player_client=mweb" \
      -f "best[ext=mp4][height<=1080]/best[height<=1080]/best"`;
    
    if (cookiesPath) {
      ytDlpCommand += ` --cookies "${cookiesPath}"`;
    }
    
    ytDlpCommand += ` \
      --downloader ffmpeg \
      --downloader-args "ffmpeg_i:-ss ${startTime} -t ${duration}" \
      -o "${rawDownloadPath}" \
      "${videoUrl}"`;

    await execPromise(ytDlpCommand, { 
      maxBuffer: 50 * 1024 * 1024,
      timeout: 180000
    });
    
    console.log('Step 2: Adding text overlays...');
    
    const cleanText = (text) => {
      return text
        .replace(/[^\x00-\x7F]/g, '')
        .replace(/'/g, "'\\''")
        .trim();
    };
    
    const captionText = cleanText(caption || 'Amazing Content!');
    const ctaText = cleanText(cta || 'Follow for more!');
    
    await execPromise(`ffmpeg -i "${rawDownloadPath}" \
      -vf "scale=w=1080:h=ih*1080/iw:force_original_aspect_ratio=decrease,\
      pad=w=1080:h=1920:x=(ow-iw)/2:y=(oh-ih)/2:color=black,\
      drawtext=fontfile=/usr/share/fonts/liberation/LiberationSans-Bold.ttf:\
      text='${captionText}':x=(w-text_w)/2:y=80:fontsize=52:fontcolor=white:\
      box=1:boxcolor=black@0.7:boxborderw=15,\
      drawtext=fontfile=/usr/share/fonts/liberation/LiberationSans-Bold.ttf:\
      text='${ctaText}':x=(w-text_w)/2:y=h-150:fontsize=42:fontcolor=white:\
      box=1:boxcolor=red@0.8:boxborderw=12" \
      -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k "${outputPath}" -y`, {
      timeout: 120000
    });
    
    console.log('Step 3: Getting file info...');
    
    // Get file size
    const stats = await fs.stat(outputPath);
    
    // Cleanup raw file
    await fs.unlink(rawDownloadPath).catch(() => {});
    
    console.log('Success! Video ready for download');
    
    // Return URL instead of base64
    const downloadUrl = `${req.protocol}://${req.get('host')}/downloads/${fileName}_processed.mp4`;
    
    res.json({
      success: true,
      downloadUrl: downloadUrl,
      fileName: `${fileName}_processed.mp4`,
      size: stats.size,
      segment: {
        start: startTime,
        duration: duration
      },
      expiresIn: '10 minutes'
    });
    
  } catch (error) {
    console.error('Error:', error);
    
    // Cleanup
    try {
      await fs.unlink(rawDownloadPath).catch(() => {});
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
