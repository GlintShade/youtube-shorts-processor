const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json({ limit: '100mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'youtube-shorts-processor' });
});

// Initialize cookies file from environment variable
async function setupCookies() {
  const cookiesContent = process.env.YT_COOKIES;
  
  if (cookiesContent) {
    const cookiesPath = '/tmp/cookies.txt';
    await fs.writeFile(cookiesPath, cookiesContent, 'utf8');
    console.log('Cookies file created from environment variable');
    return cookiesPath;
  }
  
  console.log('No cookies provided - downloads may fail for some videos');
  return null;
}

let cookiesPath = null;
setupCookies().then(path => { cookiesPath = path; });

// Download and process specific segment
app.post('/process-segment', async (req, res) => {
  const { videoUrl, startTime, duration = 60, caption, cta } = req.body;
  
  if (!videoUrl || startTime === undefined) {
    return res.status(400).json({ error: 'videoUrl and startTime required' });
  }

  const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const rawDownloadPath = `/tmp/${fileName}_raw.mp4`;
  const cutPath = `/tmp/${fileName}_cut.mp4`;
  const outputPath = `/tmp/${fileName}_processed.mp4`;

  try {
    console.log(`Step 1: Downloading video segment starting at ${startTime}s`);
    
    // Download with yt-dlp using FFmpeg to cut during download
    let ytDlpCommand = `yt-dlp \
      --extractor-args "youtube:player_client=mweb" \
      -f "best[ext=mp4][height<=1080]/best[height<=1080]/best"`;
    
    if (cookiesPath) {
      ytDlpCommand += ` --cookies "${cookiesPath}"`;
    }
    
    // Use FFmpeg downloader to cut segment during download (much faster!)
    ytDlpCommand += ` \
      --downloader ffmpeg \
      --downloader-args "ffmpeg_i:-ss ${startTime} -t ${duration}" \
      -o "${rawDownloadPath}" \
      "${videoUrl}"`;

    console.log('Downloading with FFmpeg segment cutting...');
    const { stdout, stderr } = await execPromise(ytDlpCommand, { 
      maxBuffer: 50 * 1024 * 1024,
      timeout: 180000 // 3 minute timeout
    });
    
    if (stdout) console.log('Download complete');
    
    console.log('Step 2: Adding text overlays...');
    
    // Prepare text overlays - remove emojis and special chars
    const cleanText = (text) => {
      return text
        .replace(/[^\x00-\x7F]/g, '') // Remove non-ASCII
        .replace(/'/g, "'\\''")       // Escape quotes
        .trim();
    };
    
    const captionText = cleanText(caption || 'Amazing Content!');
    const ctaText = cleanText(cta || 'Follow for more!');
    
    // Process video: convert to vertical 9:16 with text overlays
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
      timeout: 120000 // 2 minute timeout for processing
    });
    
    console.log('Step 3: Reading processed video...');
    
    // Read file and return as base64
    const videoBuffer = await fs.readFile(outputPath);
    const base64Video = videoBuffer.toString('base64');
    
    // Cleanup
    await fs.unlink(rawDownloadPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
    
    console.log('Success! Video processed and encoded.');
    
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
    console.error('Error details:', error);
    
    // Cleanup on error
    try {
      await fs.unlink(rawDownloadPath).catch(() => {});
      await fs.unlink(cutPath).catch(() => {});
      await fs.unlink(outputPath).catch(() => {});
    } catch {}
    
    res.status(500).json({ 
      error: 'Processing failed', 
      details: error.message,
      stderr: error.stderr || 'No stderr available'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`YouTube Shorts Processor running on port ${PORT}`);
  console.log(`Cookies ${cookiesPath ? 'loaded' : 'not provided'}`);
});
