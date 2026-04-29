import { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import JSZip from "jszip";
import "./App.css";

import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";

const ffmpeg = new FFmpeg();
const MAX_THUMB_WIDTH = 640;
const DEFAULT_QUALITY_PERCENT = 85;

export default function App() {
  const inputRef = useRef(null);
  const generationRef = useRef(0);
  const ffmpegListenersAttachedRef = useRef(false);
  const [file, setFile] = useState(null);
  const [engine, setEngine] = useState("canvas");
  const [count, setCount] = useState(12);
  const [qualityPercent, setQualityPercent] = useState(DEFAULT_QUALITY_PERCENT);
  const [status, setStatus] = useState("Drop a video to begin");
  const [thumbs, setThumbs] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return () => {
      thumbs.forEach((thumb) => URL.revokeObjectURL(thumb.url));
    };
  }, [thumbs]);

  function debug(runId, stage, details) {
    const prefix = `[thumbgen:${runId}] ${stage}`;
    if (details === undefined) {
      console.info(prefix);
      return;
    }

    console.info(prefix, details);
  }

  async function loadFFmpeg() {
    if (ffmpeg.loaded) return;

    setStatus("Loading FFmpeg...");

    await ffmpeg.load({
      coreURL,
      wasmURL,
    });

    if (!ffmpegListenersAttachedRef.current) {
      ffmpeg.on("log", ({ type, message }) => {
        console.info(`[ffmpeg:${type}] ${message}`);
      });

      ffmpeg.on("progress", ({ progress, time }) => {
        console.info("[ffmpeg:progress]", {
          progress,
          time,
        });
      });

      ffmpegListenersAttachedRef.current = true;
    }
  }

  function getDuration(videoFile) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = URL.createObjectURL(videoFile);
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(video.src);
        resolve(video.duration);
      };
      video.onerror = reject;
    });
  }

  function clearThumbs() {
    setThumbs((current) => {
      current.forEach((thumb) => URL.revokeObjectURL(thumb.url));
      return [];
    });
  }

  function isMemoryFailure(error) {
    const message = String(error?.message ?? error).toLowerCase();
    return (
      message.includes("memory access out of bounds") ||
      message.includes("out of memory") ||
      message.includes("runtimeerror")
    );
  }

  function getCanvasQuality() {
    return Math.min(1, Math.max(0.4, qualityPercent / 100));
  }

  function getFfmpegQualityValue() {
    // FFmpeg MJPEG quality: 2 is best, 31 is worst.
    return Math.round(31 - (qualityPercent / 100) * 29);
  }

  async function safeDelete(path) {
    try {
      await ffmpeg.deleteFile(path);
    } catch {
      // Ignore missing temp files.
    }
  }

  async function readThumbsAndZip(outputNames, runId) {
    const zip = new JSZip();
    const nextThumbs = [];

    debug(runId, "zip:start", { expectedFiles: outputNames.length });

    for (const name of outputNames) {
      try {
        debug(runId, "zip:read-file", { name });
        const data = await ffmpeg.readFile(name);
        const blob = new Blob([data.buffer], { type: "image/jpeg" });
        const url = URL.createObjectURL(blob);

        nextThumbs.push({ name, url });
        zip.file(name, blob);
      } catch {
        // FFmpeg may output fewer frames for very short videos.
        debug(runId, "zip:missing-frame", { name });
      } finally {
        await safeDelete(name);
      }
    }

    debug(runId, "zip:done", { actualFiles: nextThumbs.length });

    return { nextThumbs, zip };
  }

  async function extractBulk(inputName, duration, runId) {
    const outputNames = Array.from(
      { length: count },
      (_, index) => `thumb_${String(index + 1).padStart(2, "0")}.jpg`
    );

    debug(runId, "extract:bulk:start", {
      count,
      duration,
      maxWidth: MAX_THUMB_WIDTH,
      qualityPercent,
      ffmpegQ: getFfmpegQualityValue(),
    });

    await ffmpeg.exec([
      "-threads",
      "1",
      "-i",
      inputName,
      "-vf",
      `fps=${count}/${duration},scale='min(${MAX_THUMB_WIDTH},iw)':-2`,
      "-q:v",
      String(getFfmpegQualityValue()),
      "-frames:v",
      String(count),
      "thumb_%02d.jpg",
    ]);

    debug(runId, "extract:bulk:done");

    return outputNames;
  }

  async function extractSequential(inputName, duration, runId) {
    const outputNames = [];

    debug(runId, "extract:sequential:start", {
      count,
      duration,
      maxWidth: MAX_THUMB_WIDTH,
      qualityPercent,
      ffmpegQ: getFfmpegQualityValue(),
    });

    for (let i = 1; i <= count; i++) {
      const name = `thumb_${String(i).padStart(2, "0")}.jpg`;
      const timestamp = (duration * i) / (count + 1);

      debug(runId, "extract:sequential:frame:start", {
        index: i,
        timestamp,
        name,
      });

      await ffmpeg.exec([
        "-threads",
        "1",
        "-ss",
        timestamp.toFixed(3),
        "-i",
        inputName,
        "-frames:v",
        "1",
        "-q:v",
        String(getFfmpegQualityValue()),
        "-vf",
        `scale='min(${MAX_THUMB_WIDTH},iw)':-2`,
        name,
      ]);

      outputNames.push(name);
      debug(runId, "extract:sequential:frame:done", { index: i, name });
    }

    debug(runId, "extract:sequential:done", { frames: outputNames.length });

    return outputNames;
  }

  function waitForVideoEvent(video, eventName) {
    return new Promise((resolve, reject) => {
      const onOk = () => {
        cleanup();
        resolve();
      };

      const onErr = (event) => {
        cleanup();
        reject(event instanceof Error ? event : new Error(String(event)));
      };

      const cleanup = () => {
        video.removeEventListener(eventName, onOk);
        video.removeEventListener("error", onErr);
      };

      video.addEventListener(eventName, onOk, { once: true });
      video.addEventListener("error", onErr, { once: true });
    });
  }

  async function seekVideo(video, timestamp) {
    const maxTime = Math.max(0, (video.duration || 0) - 0.05);
    const target = Math.min(timestamp, maxTime);

    if (Math.abs((video.currentTime || 0) - target) < 0.05) return;

    const seekPromise = waitForVideoEvent(video, "seeked");
    video.currentTime = target;
    await seekPromise;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Canvas blob creation failed"));
            return;
          }

          resolve(blob);
        },
        "image/jpeg",
        quality
      );
    });
  }

  async function extractWithCanvas(videoFile, duration, runId) {
    const canvasQuality = getCanvasQuality();

    debug(runId, "extract:canvas:start", {
      count,
      duration,
      qualityPercent,
      canvasQuality,
    });

    const video = document.createElement("video");
    const sourceURL = URL.createObjectURL(videoFile);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = sourceURL;

    try {
      await waitForVideoEvent(video, "loadedmetadata");

      const width = Math.min(MAX_THUMB_WIDTH, video.videoWidth || MAX_THUMB_WIDTH);
      const height = Math.max(1, Math.round((width * (video.videoHeight || 1)) / (video.videoWidth || 1)));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });

      if (!ctx) {
        throw new Error("Canvas 2D context unavailable");
      }

      const zip = new JSZip();
      const nextThumbs = [];

      for (let i = 1; i <= count; i++) {
        const name = `thumb_${String(i).padStart(2, "0")}.jpg`;
        const timestamp = (duration * i) / (count + 1);

        debug(runId, "extract:canvas:frame:start", { index: i, timestamp, name });
        await seekVideo(video, timestamp);

        ctx.drawImage(video, 0, 0, width, height);
        const blob = await canvasToBlob(canvas, canvasQuality);
        const url = URL.createObjectURL(blob);

        nextThumbs.push({ name, url });
        zip.file(name, blob);
        debug(runId, "extract:canvas:frame:done", { index: i, bytes: blob.size });
      }

      debug(runId, "extract:canvas:done", { frames: nextThumbs.length });
      return { nextThumbs, zip };
    } finally {
      URL.revokeObjectURL(sourceURL);
    }
  }

  async function generate() {
    if (!file) return;

    const runId = ++generationRef.current;
    const startedAt = performance.now();
    debug(runId, "generate:start", {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      requestedThumbs: count,
      qualityPercent,
    });

    setBusy(true);
    clearThumbs();

    try {
      const duration = await getDuration(file);
      const ext = file.name.split(".").pop() || "mp4";
      const inputName = `input.${ext}`;
      debug(runId, "video:metadata", { duration, ext, inputName });

      let nextThumbs = [];
      let zip = null;

      if (engine === "canvas") {
        setStatus("Extracting thumbnails with Canvas...");
        ({ nextThumbs, zip } = await extractWithCanvas(file, duration, runId));
      } else {
        setStatus("Reading video...");
        debug(runId, "video:write:start", { inputName });
        await loadFFmpeg();
        debug(runId, "ffmpeg:loaded", { loaded: ffmpeg.loaded });
        await ffmpeg.writeFile(inputName, await fetchFile(file));
        debug(runId, "video:write:done", { inputName });

        let outputNames = [];

        try {
          setStatus("Extracting thumbnails...");
          outputNames = await extractBulk(inputName, duration, runId);
        } catch (error) {
          debug(runId, "extract:bulk:error", {
            message: String(error?.message ?? error),
          });
          if (!isMemoryFailure(error)) throw error;

          setStatus("Memory limit hit. Retrying in low-memory mode...");
          outputNames = await extractSequential(inputName, duration, runId);
        }

        ({ nextThumbs, zip } = await readThumbsAndZip(outputNames, runId));
        await safeDelete(inputName);
      }

      setThumbs(nextThumbs);
      debug(runId, "thumbs:set", { count: nextThumbs.length });

      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipUrl = URL.createObjectURL(zipBlob);
      debug(runId, "zip:generated", { bytes: zipBlob.size });

      const a = document.createElement("a");
      a.href = zipUrl;
      a.download = `${file.name.replace(/\.[^/.]+$/, "")}-thumbnails.zip`;
      a.click();

      URL.revokeObjectURL(zipUrl);
      debug(runId, "cleanup:done", { inputName });
      setStatus(`Done — generated ${nextThumbs.length} thumbnails`);

      debug(runId, "generate:done", {
        ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      console.error(error);
      debug(runId, "generate:error", {
        message: String(error?.message ?? error),
        stack: error?.stack,
      });
      setStatus("Something went wrong. Try a smaller video first.");
    } finally {
      setBusy(false);
    }
  }

  function handleFiles(files) {
    const nextFile = files?.[0];
    if (!nextFile) return;

    setFile(nextFile);
    setThumbs([]);
    setStatus(`Selected: ${nextFile.name}`);
  }

  return (
    <main className="app">
      <section className="card">
        <div className="hero">
          <p className="eyebrow">Thumbnail Lab</p>
          <h1>Generate better video thumbnails</h1>
          <p>
            Drop a video, choose how many frames to extract, and download them
            as a ZIP.
          </p>
        </div>

        <fieldset className="control mode-control">
          <span>Extraction mode</span>
          <label>
            <input
              type="radio"
              name="engine"
              value="canvas"
              checked={engine === "canvas"}
              onChange={(e) => setEngine(e.target.value)}
            />
            Canvas (recommended)
          </label>
          <label>
            <input
              type="radio"
              name="engine"
              value="ffmpeg"
              checked={engine === "ffmpeg"}
              onChange={(e) => setEngine(e.target.value)}
            />
            FFmpeg
          </label>
          {engine === "ffmpeg" && (
            <small>
              FFmpeg in the browser can run out of memory on large or
              high-bitrate videos. Switch to Canvas mode for better
              reliability.
            </small>
          )}
        </fieldset>

        <div
          className="dropzone"
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            handleFiles(e.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => handleFiles(e.target.files)}
          />

          <strong>{file ? file.name : "Drop video here"}</strong>
          <span>{file ? "Click to choose another" : "or click to browse"}</span>
        </div>

        <label className="control">
          <span>Number of thumbnails</span>
          <input
            type="range"
            min="4"
            max="128"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
          <b>{count}</b>
        </label>

        <label className="control">
          <span>Quality (%)</span>
          <input
            type="range"
            min="40"
            max="100"
            step="1"
            value={qualityPercent}
            onChange={(e) => setQualityPercent(Number(e.target.value))}
          />
          <b>{qualityPercent}%</b>
        </label>

        <button disabled={!file || busy} onClick={generate}>
          {busy ? "Generating..." : "Generate ZIP"}
        </button>

        <p className="status">{status}</p>

        {thumbs.length > 0 && (
          <div className="grid">
            {thumbs.map((thumb) => (
              <a key={thumb.name} href={thumb.url} download={thumb.name}>
                <img src={thumb.url} alt={thumb.name} />
              </a>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}