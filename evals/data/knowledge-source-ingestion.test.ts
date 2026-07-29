import { describe, expect, test } from "vitest";
import { zipSync } from "fflate";
import {
  chunkKnowledgeText,
  matchesDeclaredKnowledgeSize,
  parseKnowledgeDocument,
  validateKnowledgeUpload,
} from "@/lib/knowledge-sources/ingestion";

describe("Knowledge Source ingestion", () => {
  test("requires actual upload bytes to match the quota reservation", () => {
    expect(matchesDeclaredKnowledgeSize(20_000_000, 1)).toBe(false);
    expect(matchesDeclaredKnowledgeSize(20_000_000, 20_000_000)).toBe(true);
    expect(matchesDeclaredKnowledgeSize(1, null)).toBe(false);
  });

  test("accepts supported documents and rejects disguised or oversized files", () => {
    expect(
      validateKnowledgeUpload({
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 20,
      }),
    ).toEqual({ ok: true, mimeType: "text/plain" });
    expect(
      validateKnowledgeUpload({
        filename: "notes.exe",
        mimeType: "text/plain",
        sizeBytes: 20,
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateKnowledgeUpload({
        filename: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 20_000_001,
      }),
    ).toMatchObject({ ok: false });
  });

  test("keeps plain text exact apart from safe newline normalization", async () => {
    await expect(
      parseKnowledgeDocument(
        Buffer.from("First line\r\n\r\nSecond line"),
        "text/plain",
      ),
    ).resolves.toBe("First line\n\nSecond line");
  });

  test("rejects a PDF whose bytes do not match its declared type", async () => {
    await expect(
      parseKnowledgeDocument(Buffer.from("not a pdf"), "application/pdf"),
    ).rejects.toThrow("file_type_mismatch");
  });

  test("rejects a DOCX archive without a bounded valid central directory", async () => {
    const fakeArchive = Buffer.alloc(100);
    fakeArchive.write("PK", 0, "ascii");
    await expect(
      parseKnowledgeDocument(
        fakeArchive,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).rejects.toThrow("file_type_mismatch");
  });

  test("rejects DOCX expansion beyond the limit even when ZIP sizes are forged", async () => {
    const archive = Buffer.from(
      zipSync(
        {
          "[Content_Types].xml": Buffer.from("<Types />"),
          "word/document.xml": Buffer.alloc(20_000_001, 65),
        },
        { level: 9 },
      ),
    );
    for (let offset = 0; offset + 30 < archive.length; offset += 1) {
      const signature = archive.readUInt32LE(offset);
      if (signature === 0x04034b50) {
        archive.writeUInt32LE(1, offset + 22);
      } else if (signature === 0x02014b50) {
        archive.writeUInt32LE(1, offset + 24);
      }
    }
    await expect(
      parseKnowledgeDocument(
        archive,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).rejects.toThrow("unsafe_document_archive");
  });

  test("chunks deterministically with bounded overlap and stable offsets", () => {
    const text = `${"A".repeat(1700)}\n\n${"B".repeat(1700)}`;
    const chunks = chunkKnowledgeText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 2200)).toBe(true);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
  });
});
