import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { Unzip, UnzipInflate } from "fflate";

export const KNOWLEDGE_SOURCE_BUCKET = "knowledge-sources";
export const MAX_KNOWLEDGE_FILE_BYTES = 20_000_000;
export const MAX_KNOWLEDGE_TEXT_CHARS = 1_500_000;

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "text/plain": ["txt", "md", "markdown", "csv", "tsv", "json", "log"],
  "text/csv": ["csv"],
  "text/tab-separated-values": ["tsv"],
  "application/json": ["json"],
  "application/pdf": ["pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    "docx",
  ],
  "application/rtf": ["rtf"],
  "text/rtf": ["rtf"],
};

export type KnowledgeChunk = {
  ordinal: number;
  content: string;
  contentHash: string;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
};

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateKnowledgeUpload(input: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): { ok: true; mimeType: string } | { ok: false; error: string } {
  const filename = input.filename.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (!filename || filename.length > 255 || filename.includes("/") || filename.includes("\\")) {
    return { ok: false, error: "Choose a file with a valid name." };
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1) {
    return { ok: false, error: "This file is empty." };
  }
  if (input.sizeBytes > MAX_KNOWLEDGE_FILE_BYTES) {
    return { ok: false, error: "Files must be 20 MB or smaller." };
  }
  if (!MIME_EXTENSIONS[mimeType]?.includes(extension)) {
    return {
      ok: false,
      error: "Use a PDF, DOCX, RTF, TXT, Markdown, CSV, TSV, JSON, or log file.",
    };
  }
  return { ok: true, mimeType };
}

export function matchesDeclaredKnowledgeSize(
  actualSizeBytes: number,
  declaredSizeBytes: unknown,
): boolean {
  return (
    Number.isInteger(actualSizeBytes) &&
    typeof declaredSizeBytes === "number" &&
    Number.isInteger(declaredSizeBytes) &&
    actualSizeBytes === declaredSizeBytes
  );
}

function assertMagicBytes(buffer: Buffer, mimeType: string): void {
  const valid =
    mimeType === "application/pdf"
      ? buffer.subarray(0, 4).toString("ascii") === "%PDF"
      : mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ? buffer.subarray(0, 2).toString("ascii") === "PK"
        : mimeType === "application/rtf" || mimeType === "text/rtf"
          ? buffer.subarray(0, 5).toString("ascii").startsWith("{\\rtf")
          : true;
  if (!valid) throw new Error("file_type_mismatch");
}

function assertDocxArchiveBounds(buffer: Buffer): void {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("file_type_mismatch");
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (
    entries < 1 ||
    entries > 2000 ||
    centralOffset + centralSize > buffer.length
  ) {
    throw new Error("unsafe_document_archive");
  }
  let cursor = centralOffset;
  let totalUncompressed = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("unsafe_document_archive");
    }
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    totalUncompressed += uncompressed;
    if (
      uncompressed > 20_000_000 ||
      totalUncompressed > 50_000_000 ||
      (compressed > 0 && uncompressed / compressed > 100)
    ) {
      throw new Error("unsafe_document_archive");
    }
    hasContentTypes ||= name === "[Content_Types].xml";
    hasDocument ||= name === "word/document.xml";
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (!hasContentTypes || !hasDocument) throw new Error("file_type_mismatch");
}

async function assertDocxExpandedBounds(buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let entries = 0;
    let pendingFiles = 0;
    let pushedAllInput = false;
    let totalExpanded = 0;
    let settled = false;
    const finishIfDone = () => {
      if (!settled && pushedAllInput && pendingFiles === 0) {
        settled = true;
        resolve();
      }
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("unsafe_document_archive"));
    };
    const unzip = new Unzip((file) => {
      if (settled) return;
      entries += 1;
      if (entries > 2000) {
        fail();
        return;
      }
      pendingFiles += 1;
      let fileExpanded = 0;
      file.ondata = (error, chunk, final) => {
        if (settled) return;
        if (error) {
          fail();
          return;
        }
        fileExpanded += chunk.byteLength;
        totalExpanded += chunk.byteLength;
        if (
          fileExpanded > 20_000_000 ||
          totalExpanded > 50_000_000
        ) {
          file.terminate?.();
          fail();
          return;
        }
        if (final) {
          pendingFiles -= 1;
          finishIfDone();
        }
      };
      try {
        file.start();
      } catch {
        fail();
      }
    });
    unzip.register(UnzipInflate);
    try {
      const inputChunkSize = 64 * 1024;
      for (
        let offset = 0;
        offset < buffer.byteLength && !settled;
        offset += inputChunkSize
      ) {
        const end = Math.min(buffer.byteLength, offset + inputChunkSize);
        unzip.push(
          buffer.subarray(offset, end),
          end === buffer.byteLength,
        );
      }
      pushedAllInput = true;
      if (entries < 1) fail();
      else finishIfDone();
    } catch {
      fail();
    }
  });
}

async function parseIsolated(
  buffer: Buffer,
  kind: "pdf" | "docx",
): Promise<string> {
  const require = createRequire(`${process.cwd()}/package.json`);
  const modulePath =
    kind === "pdf"
      ? require.resolve("pdf-parse/lib/pdf-parse.js")
      : require.resolve("mammoth");
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const input = Buffer.from(workerData.buffer);
      const parser = require(workerData.modulePath);
      const text = workerData.kind === "pdf"
        ? (await parser(input)).text
        : (await parser.extractRawText({ buffer: input })).value;
      parentPort.postMessage({ text });
    })().catch((error) => {
      parentPort.postMessage({ error: error && error.message ? error.message : "parse_failed" });
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { buffer, kind, modulePath },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error("document_parse_timeout"));
    }, 20_000);
    worker.once("message", (message: { text?: unknown; error?: unknown }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if (typeof message.text === "string") resolve(message.text);
      else reject(new Error("document_parse_failed"));
    });
    worker.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("document_parse_failed"));
    });
  });
}

function parseRtf(buffer: Buffer): string {
  return buffer
    .toString("utf8")
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\'[0-9a-f]{2}/gi, (value) =>
      String.fromCharCode(Number.parseInt(value.slice(2), 16)),
    )
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "");
}

export async function parseKnowledgeDocument(
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  assertMagicBytes(buffer, mimeType);
  let text: string;
  if (mimeType === "application/pdf") {
    text = await parseIsolated(buffer, "pdf");
  } else if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    assertDocxArchiveBounds(buffer);
    await assertDocxExpandedBounds(buffer);
    text = await parseIsolated(buffer, "docx");
  } else if (mimeType === "application/rtf" || mimeType === "text/rtf") {
    text = parseRtf(buffer);
  } else {
    text = buffer.toString("utf8");
  }
  const normalized = text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  if (!normalized) throw new Error("no_extractable_text");
  if (normalized.length > MAX_KNOWLEDGE_TEXT_CHARS) {
    throw new Error("extracted_text_too_large");
  }
  return normalized;
}

export function chunkKnowledgeText(
  text: string,
  targetChars = 1800,
  overlapChars = 180,
): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + targetChars);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const paragraph = text.lastIndexOf("\n\n", hardEnd);
      const line = text.lastIndexOf("\n", hardEnd);
      const boundary = Math.max(paragraph >= start + 900 ? paragraph + 2 : -1, line >= start + 900 ? line + 1 : -1);
      if (boundary > start) end = boundary;
    }
    const content = text.slice(start, end).trim();
    if (content) {
      chunks.push({
        ordinal: chunks.length,
        content,
        contentHash: sha256(content),
        tokenCount: Math.max(1, Math.ceil(content.length / 4)),
        startOffset: start,
        endOffset: end,
      });
    }
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}
