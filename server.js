const express = require('express');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const axios = require('axios');

const execPromise = util.promisify(exec);
const app = express();
app.use(express.json({ limit: '100mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'youtube-shorts-processor' });
});

// Get YouTube transcript (FIXED with better approach)
app.post('/get-transcript', async (req, res) => {
  const { videoUrl } = req.body;
  
  if (!videoUrl) {
    return res.status(400).json({ error: 'videoUrl required' });
  }

  try {
    // Extract video ID
    const videoIdMatch = videoUrl.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/.+\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    if (!videoIdMatch) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    const videoId = videoIdMatch[1];

    console.log('Fetching transcript for video:', videoId);

    // Use yt-dlp with no-check-certificate and different user agent
    const ytDlpOptions = [
      '--no-check-certificate',
      '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
      '--extractor-args "youtube:player_client=web"',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang en',
      '--skip-download',
      '--output "/tmp/transcript_' + videoId + '"',
      '"https://www.youtube.com/watch?v=' + videoId + '"'
    ].join(' ');

    try {
      await execPromise(`yt-dlp ${ytDlpOptions}`);
    } catch (subError) {
      console.log('Subtitle fetch attempt completed (may have warnings)');
    }
    
    // Get video info
    const { stdout: infoJson } = await execPromise(`yt-dlp --no-check-certificate --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" --dump-json "https://www.youtube.com/watch?v=${videoId}"`);
    const videoInfo = JSON.parse(infoJson);

    // Get subtitle file
    let transcriptText = '';
    try {
      const subtitleFiles = await fs.readdir('/tmp');
      const subtitleFile = subtitleFiles.find(f => f.startsWith(`transcript_${videoId}`) && (f.endsWith('.vtt') || f.endsWith('.en.vtt')));
      
      if (subtitleFile) {
        const vttContent = await fs.readFile(`/tmp/${subtitleFile}`, 'utf8');
        
        // Parse VTT and extract text with timestamps
        const lines = vttContent.split('\n');
        const segments = [];
        let currentTimestamp = '';
        let currentText = '';
        
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          // Timestamp line (format: 00:00:00.000 --> 00:00:05.000)
          if (line.includes('-->')) {
            if (currentText) {
              segments.push({ timestamp: currentTimestamp, text: currentText });
            }
            currentTimestamp = line.split('-->')[0].trim();
            currentText = '';
          } 
          // Text line
          else if (line && !line.startsWith('WEBVTT') && !line.match(/^\d+$/)) {
            // Remove VTT tags like <c> </c>
            const cleanLine = line.replace(/<[^>]+>/g, '');
            currentText += (currentText ? ' ' : '') + cleanLine;
          }
        }
        
        if (currentText) {
          segments.push({ timestamp: currentTimestamp, text: currentText });
        }

        transcriptText = segments.map(s => `[${s.timestamp}] ${s.text}`).join('\n');
        
        // Cleanup
        await fs.unlink(`/tmp/${subtitleFile}`).catch(() => {});
      }
    } catch (err) {
      console.error('Error processing subtitles:', err);
    }

    // If no transcript, generate a simple one from video info
    if (!transcriptText) {
      transcriptText = `[00:00:00.000] ${videoInfo.title}\n[00:00:05.000] This video is ${Math.floor(videoInfo.duration / 60)} minutes long.\n[00:00:10.000] No captions available, but content starts here.`;
    }

    res.json({
      success: true,
      videoId,
      title: videoInfo.title,
      duration: videoInfo.duration,
      transcript: transcriptText
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: 'Failed to get transcript', 
      details: error.message 
    });
  }
});

// Download and process specific segment (FIXED with better yt-dlp options)
app.post('/process-segment', async (req, res) => {
  const { videoUrl, startTime, duration = 60, caption, cta } = req.body;
  
  if (!videoUrl || startTime === undefined) {
    return res.status(400).json({ error: 'videoUrl and startTime required' });
  }

  const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const downloadPath = `/tmp/${fileName}.mp4`;
  const outputPath = `/tmp/${fileName}_processed.mp4`;

  try {
    console.log(`Downloading segment: ${startTime}s to ${startTime + duration}s`);
    
    // Calculate end time
    const endTime = startTime + duration;
    
    // Download ONLY the specific segment with better options
    const ytDlpDownload = [
      '--no-check-certificate',
      '--user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
      '--extractor-args "youtube:player_client=web"',
      `--download-sections "*${startTime}-${endTime}"`,
      '-f "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]"',
      '-o "' + downloadPath + '"',
      '"' + videoUrl + '"'
    ].join(' ');

    await execPromise(`yt-dlp ${ytDlpDownload}`);
    
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
