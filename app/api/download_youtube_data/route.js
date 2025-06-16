// app/api/download_youtube_data/route.js (for Next.js App Router)

import { NextResponse } from "next/server";
import ytdl from "ytdl-core";
import ffmpeg from "fluent-ffmpeg";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "stream";
import { promises as fs } from "fs";
import path from "path";
import os from "os"; // For temporary directory

// Configure FFmpeg path if not in system PATH (e.g., on Windows)
// ffmpeg.setFfmpegPath('/path/to/your/ffmpeg'); // Uncomment if needed

// --- AWS S3 Configuration (Read from environment variables) ---
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION;
const API_KEY = process.env.API_KEY;

// Initialize S3 Client
let s3Client;
if (
  AWS_ACCESS_KEY_ID &&
  AWS_SECRET_ACCESS_KEY &&
  S3_BUCKET_NAME &&
  AWS_DEFAULT_REGION
) {
  s3Client = new S3Client({
    region: AWS_DEFAULT_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
    },
  });
  console.log(
    `S3 client initialized for bucket: ${S3_BUCKET_NAME} in region: ${AWS_DEFAULT_REGION}`
  );
} else {
  console.error(
    "ERROR: Missing AWS S3 environment variables! S3 operations will be disabled."
  );
}

export async function POST(request) {
  try {
    // --- API Key Authentication ---
    const apiKeyHeader = request.headers.get("X-API-Key");
    if (API_KEY && apiKeyHeader !== API_KEY) {
      console.warn("Unauthorized access attempt due to invalid API Key.");
      return NextResponse.json(
        { status: "error", message: "Unauthorized: Invalid API Key" },
        { status: 401 }
      );
    }

    const data = await request.json();
    const youtubeUrl = data.youtube_url;

    // --- Input Validation ---
    if (!youtubeUrl) {
      console.warn("Bad request: Missing 'youtube_url' in request body.");
      return NextResponse.json(
        { status: "error", message: "Missing 'youtube_url' in request body." },
        { status: 400 }
      );
    }
    if (
      !/^https?:\/\/(www\.)?(youtube|youtu|youtube-nocookie)\.(com|be)\/.+/.test(
        youtubeUrl
      )
    ) {
      console.warn(`Invalid YouTube URL format received: ${youtubeUrl}`);
      return NextResponse.json(
        { status: "error", message: "Invalid YouTube URL format." },
        { status: 400 }
      );
    }

    console.log(`Processing request for YouTube URL: ${youtubeUrl}`);

    if (!s3Client) {
      throw new Error("S3 client not initialized. Cannot upload video.");
    }

    // --- Get Video Info ---
    const info = await ytdl.getInfo(youtubeUrl);
    const videoTitle = info.videoDetails.title;
    const videoId = info.videoDetails.videoId;
    const sanitizedTitle = videoTitle
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_");
    const s3ObjectKey = `youtube_downloads/${sanitizedTitle}_${videoId}.mp4`;

    let videoStream = null;
    let audioStream = null;
    let finalFilePath = null;
    let tempDir = null; // Declare tempDir outside for finally block

    try {
      // --- Select Streams ---
      // Prioritize combined streams up to 720p if available and decent quality
      const combinedStream = ytdl.chooseFormat(info.formats, {
        quality: "highestvideo",
        filter: "videoandaudio",
      });

      if (
        combinedStream &&
        parseInt(combinedStream.qualityLabel.slice(0, -1)) >= 360
      ) {
        console.log(
          `Downloading combined stream: ${combinedStream.qualityLabel}`
        );
        videoStream = ytdl(youtubeUrl, { format: combinedStream });
      } else {
        // Fallback to separate video and audio streams for higher quality (requires FFmpeg for merging)
        console.log(
          "Falling back to separate video/audio download for higher quality (requires FFmpeg)."
        );
        videoStream = ytdl(youtubeUrl, {
          quality: "highestvideo",
          filter: "videoonly",
        });
        audioStream = ytdl(youtubeUrl, {
          quality: "highestaudio",
          filter: "audioonly",
        });

        if (!videoStream || !audioStream) {
          throw new Error(
            "Could not find suitable high-quality video or audio stream for merging. Try a lower quality or a different video."
          );
        }
      }

      // --- Create temporary directory for download and processing ---
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-dl-"));
      const outputFilename = `${videoId}_${sanitizedTitle}.mp4`;
      finalFilePath = path.join(tempDir, outputFilename);

      if (audioStream) {
        // Merge video and audio using FFmpeg
        console.log(
          `Merging video and audio with FFmpeg to: ${outputFilename}`
        );
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(videoStream)
            .videoCodec("copy")
            .input(audioStream)
            .audioCodec("aac") // or 'copy' if compatible
            .format("mp4")
            .on("error", (err) => {
              console.error("FFmpeg error:", err.message);
              reject(new Error(`FFmpeg processing failed: ${err.message}`));
            })
            .on("end", () => {
              console.log("FFmpeg processing finished.");
              resolve();
            })
            .save(finalFilePath);
        });
      } else if (videoStream) {
        // If only a combined stream was selected, just pipe it to a file
        console.log(`Saving combined stream to: ${outputFilename}`);
        await new Promise((resolve, reject) => {
          const fileWriteStream = fs.createWriteStream(finalFilePath);
          videoStream.pipe(fileWriteStream);
          fileWriteStream.on("finish", resolve);
          fileWriteStream.on("error", reject);
        });
      } else {
        throw new Error("No suitable video stream found.");
      }

      // --- Upload to S3 ---
      console.log(
        `Uploading ${outputFilename} to S3 bucket ${S3_BUCKET_NAME} as ${s3ObjectKey}`
      );
      const fileBuffer = await fs.readFile(finalFilePath);
      const uploadCommand = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: s3ObjectKey,
        Body: fileBuffer,
        ContentType: "video/mp4", // Set content type for direct playback in browser
      });
      await s3Client.send(uploadCommand);
      console.log("Upload complete.");

      // --- Generate Pre-Signed S3 URL (valid for 1 hour) ---
      const downloadLink = await getSignedUrl(
        s3Client,
        new PutObjectCommand({
          Bucket: S3_BUCKET_NAME,
          Key: s3ObjectKey,
        }),
        { expiresIn: 3600 }
      ); // URL valid for 1 hour

      console.log(`Generated pre-signed URL successfully.`);

      // --- Extract other metadata ---
      const availableQualities = info.formats
        .filter((f) => f.qualityLabel || f.audioBitrate)
        .map((f) => {
          if (f.qualityLabel && f.hasVideo && f.hasAudio)
            return `${f.qualityLabel} (combined)`;
          if (f.qualityLabel && f.hasVideo && !f.hasAudio)
            return `${f.qualityLabel} (video only)`;
          if (f.audioBitrate && !f.hasVideo)
            return `${f.audioBitrate}bps (audio only)`;
          return null;
        })
        .filter(Boolean)
        .filter((value, index, self) => self.indexOf(value) === index) // Unique values
        .sort((a, b) => {
          // Sort by resolution (desc) then type
          const getRes = (s) => parseInt(s.match(/(\d+)/)?.[1] || "0");
          const aRes = getRes(a);
          const bRes = getRes(b);
          if (aRes !== bRes) return bRes - aRes;
          const order = { combined: 1, "video only": 2, "audio only": 3 };
          return (
            order[a.split("(")[1]?.slice(0, -1).trim()] -
            order[b.split("(")[1]?.slice(0, -1).trim()]
          );
        });

      return NextResponse.json(
        {
          status: "success",
          video_title: videoTitle,
          video_thumbnail_url:
            info.videoDetails.thumbnails[
              info.videoDetails.thumbnails.length - 1
            ].url,
          video_description: info.videoDetails.description,
          video_length_seconds: parseInt(info.videoDetails.lengthSeconds),
          video_views: parseInt(info.videoDetails.viewCount),
          author: info.videoDetails.author.name,
          publish_date: info.videoDetails.publishDate,
          keywords: info.videoDetails.keywords || [],
          available_qualities: availableQualities,
          download_link: downloadLink,
          message:
            "Video downloaded, uploaded to S3, and pre-signed URL generated.",
        },
        { status: 200 }
      );
    } finally {
      // Clean up temporary directory
      if (tempDir && (await fs.stat(tempDir).catch(() => null))) {
        // Check if dir exists before trying to delete
        console.log(`Cleaning up temporary directory: ${tempDir}`);
        await fs
          .rm(tempDir, { recursive: true, force: true })
          .catch((e) =>
            console.error(`Error removing temp dir ${tempDir}:`, e)
          );
      }
    }
  } catch (error) {
    console.error("Caught error in POST handler:", error);
    return NextResponse.json(
      {
        status: "error",
        message: `Failed to process YouTube link: ${error.message}. Check server logs for details.`,
        youtube_url: request.json?.()?.youtube_url, // Try to get URL if available
      },
      { status: 500 }
    );
  }
}
