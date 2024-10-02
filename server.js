const WebSocket = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { storage, db } = require("./firebaseConfig");
const { ref, uploadBytesResumable, getDownloadURL } = require("firebase/storage");
const { doc, updateDoc } = require("firebase/firestore");

const outputDir = path.join(__dirname, "hls");
const mp3Dir = path.join(__dirname, "mp3");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

if (!fs.existsSync(mp3Dir)) {
  fs.mkdirSync(mp3Dir);
}

const app = express();

app.use(cors());
app.use(express.json());
app.use('/hls', express.static(outputDir));
app.use('/mp3', express.static(mp3Dir));

app.post('/upload-audio', async (req, res) => {
  try {
    const { radioId } = req.body;
    console.log('Radio ID:', radioId);
    const mp3Dir = path.join(__dirname, "mp3");
    const audioFilePath = path.join(mp3Dir, "audio-stream.mp3");

    if (!fs.existsSync(audioFilePath)) {
      return res.status(400).json({ message: 'Audio file not found' });
    }

    const audioFile = fs.readFileSync(audioFilePath);

    // Create a reference to the audio file in Firebase Storage
    const audioRef = ref(storage, `audios/live-stream-${radioId}.mp3`);

    // Upload the file
    const audioUploadTask = uploadBytesResumable(audioRef, audioFile);
    await audioUploadTask;

    // Get the download URL
    const audioURL = await getDownloadURL(audioRef);

    // Update the Firestore document with the audio URL
    const radioDocRef = doc(db, 'radios', radioId);
    await updateDoc(radioDocRef, {
      audioURL,
      isLive: false,
      updatedAt: new Date(),
    });

    setTimeout(() => {
      fs.unlinkSync(audioFilePath);
    }, 5000); // 5 seconds delay
    res.status(200).json({ message: 'Audio uploaded and radio document updated successfully', audioURL });
  } catch (error) {
    console.error('Error uploading audio or updating Firestore document:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

const server = app.listen(5001, () => {
  console.log("HTTP server is listening on port 5001");
});

let ffmpegProcess = null;
let mp3Process = null;
let wss = null;

const startFFmpeg = () => {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGINT");
  }

  const streamKey = "audio";
  const playlist = path.join(outputDir, `${streamKey}.m3u8`);

  ffmpegProcess = spawn("ffmpeg", [
    "-f", "webm",
    "-i", "pipe:0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "20",
    "-hls_flags", "delete_segments",
    "-hls_segment_filename", path.join(outputDir, `${streamKey}_%03d.ts`),
    playlist,
  ]);

  ffmpegProcess.stdout.on("data", (data) => {
    console.log(`FFmpeg stdout: ${data}`);
  });

  ffmpegProcess.stderr.on("data", (data) => {
    console.error(`FFmpeg stderr: ${data}`);
  });

  ffmpegProcess.on("error", (err) => {
    console.error(`FFmpeg process error: ${err.message}`);
    ffmpegProcess = null;
  });

  ffmpegProcess.on("close", (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
    if (code !== 0) {
      console.error(`FFmpeg process exited with non-zero code: ${code}`);
    }
    ffmpegProcess = null;
    startFFmpeg();
  });

  startMP3Process();

  // Introduce a delay before starting the WebSocket server to allow buffer buildup
  setTimeout(() => {
    startWebSocketServer();
  }, 5000); // 5 seconds delay
};

const startMP3Process = () => {
  if (mp3Process) {
    mp3Process.kill("SIGINT");
  }

  const mp3Output = path.join(mp3Dir, `audio-stream.mp3`);

  mp3Process = spawn("ffmpeg", [
    "-f", "webm",
    "-i", "pipe:3",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    mp3Output,
  ], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe']
  });

  mp3Process.stdout.on("data", (data) => {
    console.log(`MP3 FFmpeg stdout: ${data}`);
  });

  mp3Process.stderr.on("data", (data) => {
    console.error(`MP3 FFmpeg stderr: ${data}`);
  });

  mp3Process.on("error", (err) => {
    console.error(`MP3 FFmpeg process error: ${err.message}`);
    mp3Process = null;
  });

  mp3Process.on("close", (code) => {
    console.log(`MP3 FFmpeg process exited with code ${code}`);
    if (code !== 0) {
      console.error(`MP3 FFmpeg process exited with non-zero code: ${code}`);
    }
    mp3Process = null;
  });
};

const startWebSocketServer = () => {
  if (wss) {
    wss.close();
  }

  wss = new WebSocket.Server({ server });

  wss.on("connection", (ws) => {
    console.log("Client connected");

    ws.on("message", (message) => {
      console.log(`Received message of size ${message.byteLength} bytes`);
      if (ffmpegProcess) {
        try {
          ffmpegProcess.stdin.write(Buffer.from(message));
          if (mp3Process) {
            mp3Process.stdio[3].write(Buffer.from(message)); // Send to MP3 process as well
          }
        } catch (error) {
          console.error(`Error writing to FFmpeg stdin: ${error.message}`);
        }
      } else {
        console.error("FFmpeg process not available. Dropping message.");
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
      if (ffmpegProcess) {
        ffmpegProcess.kill("SIGINT");
        ffmpegProcess = null;
      }
      if (mp3Process) {
        mp3Process.stdin.end(); // Gracefully end MP3 recording
        mp3Process.kill("SIGINT");
        mp3Process = null;
      }
    });

    ws.on("error", (error) => {
      console.error(`WebSocket error: ${error.message}`);
    });
  });
};

startFFmpeg();
