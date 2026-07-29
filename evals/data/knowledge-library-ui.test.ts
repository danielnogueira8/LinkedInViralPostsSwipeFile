import { describe, expect, test } from "vitest";
import {
  canonicalKnowledgeMimeType,
  formatKnowledgeBytes,
  formatKnowledgeDate,
  knowledgeFailureMessage,
  publicKnowledgeSource,
} from "@/lib/knowledge-sources/types";
import { NAV_BY_HREF } from "@/app/(app)/dashboard/nav-destinations";
import { MOBILE_MORE_SECTIONS } from "@/lib/mobile-navigation-policy";
import fs from "node:fs";
import path from "node:path";

const workspaceSource = fs.readFileSync(
  path.join(
    process.cwd(),
    "app/(app)/dashboard/knowledge/workspace.tsx",
  ),
  "utf8",
);

describe("Knowledge Library UI contract", () => {
  test("is available from desktop and mobile training navigation", () => {
    expect(NAV_BY_HREF["/dashboard/knowledge"]?.label).toBe("Knowledge");
    expect(
      MOBILE_MORE_SECTIONS.some((section) =>
        section.paths.some((path) => path === "/dashboard/knowledge"),
      ),
    ).toBe(true);
  });

  test("returns safe source summaries without private body or storage path", () => {
    const summary = publicKnowledgeSource({
      id: "source-1",
      kind: "file",
      title: "Calls",
      original_filename: "calls.pdf",
      mime_type: "application/pdf",
      status: "ready",
      error_code: null,
      declared_size_bytes: 1200,
      ingestion_job_id: "job-1",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:01.000Z",
    });
    expect(summary).toMatchObject({
      id: "source-1",
      originalFilename: "calls.pdf",
      sizeBytes: 1200,
    });
    expect(summary).not.toHaveProperty("rawText");
    expect(summary).not.toHaveProperty("storagePath");
  });

  test("presents useful file sizes and safe failure messages", () => {
    expect(formatKnowledgeBytes(1_500_000)).toBe("1.5 MB");
    expect(knowledgeFailureMessage("no_extractable_text")).toContain(
      "No readable text",
    );
    expect(knowledgeFailureMessage("secret-provider-detail")).toBe(
      "This source could not be processed.",
    );
  });

  test("normalizes browser MIME guesses to the supported document type", () => {
    expect(canonicalKnowledgeMimeType("notes.md", "text/markdown")).toBe(
      "text/plain",
    );
    expect(canonicalKnowledgeMimeType("calls.docx", "")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(workspaceSource).toContain("new File([file], file.name");
    expect(workspaceSource).toContain("type: canonicalMimeType");
  });

  test("uses authoritative completion verification after every upload response", () => {
    expect(workspaceSource).toContain(
      "Treat every response as an uncertain outcome",
    );
    expect(workspaceSource).not.toContain("request.status === 409");
    expect(workspaceSource).toContain(
      'fetch("/api/knowledge-sources/uploads/complete"',
    );
  });

  test("formats dates identically across server and browser locales", () => {
    expect(formatKnowledgeDate("2026-07-29T23:30:00-07:00")).toBe("Jul 30");
  });
});
