const { exec } = require('child_process');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const mongoose = require('mongoose');
const {prisma} = require("./config/prismaClient")
require('dotenv').config();

const inputS3Url = process.env.INPUT_S3_URL;
const outputBucket = process.env.OUTPUT_BUCKET_NAME;
const videoFileKey = process.env.VIDEO_FILE_KEY;
const localInputPath = `/tmp/${path.basename(videoFileKey)}`;
const localOutputPath = `/tmp/processed_${path.basename(videoFileKey, path.extname(videoFileKey))}`;

const mongoUri = process.env.MONGO_URI;


const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

async function checkFile(filePath) {
  try {
    await fsPromises.access(filePath);
    console.log(`File ${filePath} exists and is accessible`);
    const stats = await fsPromises.stat(filePath);
    console.log(`File size: ${stats.size} bytes`);
  } catch (error) {
    console.error(`Error accessing ${filePath}:`, error);
  }
}

async function downloadVideo() {
  const bucketName = inputS3Url.split('/')[2];
  const objectKey = inputS3Url.split('/').slice(3).join('/');

  console.log(`Attempting to download from bucket: ${bucketName}, key: ${objectKey}`);

  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
  });

  try {
    const { Body } = await s3Client.send(command);
    await pipeline(Body, fs.createWriteStream(localInputPath));
    console.log(`Downloaded video to ${localInputPath}`);
    await checkFile(localInputPath);
  } catch (error) {
    console.error('Error downloading video:', error);
    throw error;
  }
}

function processVideo() {
  return new Promise((resolve, reject) => {
    console.log(`Processing video: ${localInputPath}`);
    console.log(`Output path: ${localOutputPath}`);

    const command = `ffmpeg -i ${localInputPath} \
    -filter_complex \
    "[0:v]split=4[v1][v2][v3][v4]; \
    [v1]scale=-2:360[v360]; \
    [v2]scale=-2:480[v480]; \
    [v3]scale=-2:720[v720]; \
    [v4]scale=-2:1080[v1080]" \
    -map "[v360]" -c:v:0 libx264 -b:v:0 800k -map a:0 -c:a:0 aac -b:a:0 96k \
    -map "[v480]" -c:v:1 libx264 -b:v:1 1400k -map a:0 -c:a:1 aac -b:a:1 128k \
    -map "[v720]" -c:v:2 libx264 -b:v:2 2800k -map a:0 -c:a:2 aac -b:a:2 128k \
    -map "[v1080]" -c:v:3 libx264 -b:v:3 5000k -map a:0 -c:a:3 aac -b:a:3 192k \
    -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2 v:3,a:3" \
    -master_pl_name master.m3u8 \
    -f hls -hls_time 6 -hls_list_size 0 -hls_segment_filename "${localOutputPath}/%v/segment%d.ts" \
    "${localOutputPath}/%v/playlist.m3u8"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error processing video: ${stderr}`);
        reject(error);
      } else {
        console.log(`Video processed: ${stdout}`);
        resolve();
      }
    });
  });
}

async function uploadProcessedVideo() {
  async function uploadDir(dirPath) {
    const files = await fsPromises.readdir(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = await fsPromises.stat(filePath);
      if (stats.isDirectory()) {
        await uploadDir(filePath);
      } else {
        const key = `processed/${videoFileKey}/${path.relative(localOutputPath, filePath)}`;
        console.log(`Uploading file: ${filePath} to ${outputBucket}/${key}`);
        const command = new PutObjectCommand({
          Bucket: outputBucket,
          Key: key,
          Body: await fsPromises.readFile(filePath),
          ContentType: file.endsWith('.m3u8') ? 'application/x-mpegURL' : 'video/MP2T',
        });
        await s3Client.send(command);
      }
    }
  }

  try {
    await uploadDir(localOutputPath);
    console.log(`Uploaded processed video files to S3: ${outputBucket}/processed/${videoFileKey}/`);
  } catch (error) {
    console.error('Error uploading processed video:', error);
    throw error;
  }
}

async function updateVideoInMongoDB(videoFileKey) {
  try {

    const masterPlaylistUrl = `https://s3.${process.env.AWS_REGION}.amazonaws.com/${outputBucket}/processed/${videoFileKey}/master.m3u8`;

    const videoId = String(videoFileKey).split(".")[0];
    
    console.log(`Attempting to update video with ID: ${videoId}`);
    const existingVideo = await prisma.video.findUnique({
      where: { id: videoId },
    });
    
    if (!existingVideo) {
      console.log(`No video found with ID: ${videoId}`);
      return null;
    }
    
    const updatedVideo = await prisma.video.update({
      where: { id: videoId}, 
      data: { url: masterPlaylistUrl }, 
      select: { id: true, url: true}
    });
    
    
    if (updatedVideo) {
      console.log(`Video record updated in MongoDB: ${JSON.stringify(updatedVideo)}`);
    } else {
      console.log(`Failed to update video with ID: ${videoId}`);
    }
    
    return updatedVideo;
  } catch (error) {
    console.error('Error updating video record in MongoDB:', error);
    throw error;
  }
}

async function main() {
  try {
    const { connection } = await mongoose.connect(mongoUri, {
      dbName: "EarningEdge:Dev",
    });
    console.log(`MongoDB connected to ${connection.host}`);

    console.log(`Video file key: ${videoFileKey}`);

    await downloadVideo();
    await processVideo();
    await uploadProcessedVideo();
    await updateVideoInMongoDB(videoFileKey);

    console.log("Video processing completed successfully.");
  } catch (error) {
    console.error("Video processing failed:");
    console.error("Error details:", error);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  } finally {
    try {
      await fsPromises.unlink(localInputPath);
      await fsPromises.rm(localOutputPath, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error("Error during cleanup:", cleanupError);
    }
    await mongoose.connection.close();
  }
}

main();