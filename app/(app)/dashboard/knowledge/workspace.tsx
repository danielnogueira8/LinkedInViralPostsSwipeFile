"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  FileText,
  FileUp,
  LibraryBig,
  Loader2,
  NotebookPen,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  EmptyState,
  StatusPill,
  Surface,
  Toolbar,
} from "@/components/app-surface";
import {
  canonicalKnowledgeMimeType,
  formatKnowledgeBytes,
  formatKnowledgeDate,
  knowledgeFailureMessage,
  type KnowledgeSourceSummary,
} from "@/lib/knowledge-sources/types";

type Props = {
  initialSources: KnowledgeSourceSummary[];
  available: boolean;
};

type ApiResult = {
  ok: boolean;
  error?: string;
  available?: boolean;
  sources?: KnowledgeSourceSummary[];
  sourceId?: string;
  jobId?: string | null;
  status?: string;
  signedUrl?: string;
  path?: string;
};

async function jsonResponse(response: Response): Promise<ApiResult> {
  const data = (await response.json().catch(() => ({}))) as ApiResult;
  if (!response.ok || !data.ok) {
    throw new Error(data.error ?? "Something went wrong.");
  }
  return data;
}

async function hashFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function uploadSignedFile(
  signedUrl: string,
  file: File,
  canonicalMimeType: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", signedUrl);
    request.setRequestHeader("x-upsert", "false");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    // A network error can arrive after Storage committed the PUT. Completion
    // verifies the object, so continue there rather than blindly re-uploading.
    request.onerror = () => resolve();
    request.onload = () => {
      // Storage has returned both 400 and 409 for an already-committed path
      // across versions. Treat every response as an uncertain outcome and let
      // the completion endpoint verify the private object by path, size, and
      // hash before it queues ingestion.
      resolve();
    };
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append(
      "",
      new File([file], file.name, {
        type: canonicalMimeType,
        lastModified: file.lastModified,
      }),
    );
    request.send(body);
  });
}

export function KnowledgeLibrary({ initialSources, available }: Props) {
  const [sources, setSources] = useState(initialSources);
  const [query, setQuery] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const processing = sources.some(
    (source) =>
      (source.status === "pending" || source.status === "processing") &&
      source.jobId,
  );

  async function refreshSources() {
    const result = await jsonResponse(
      await fetch("/api/knowledge-sources", { cache: "no-store" }),
    );
    if (result.sources) setSources(result.sources);
  }

  useEffect(() => {
    if (!available || !processing) return;
    const timer = window.setInterval(() => {
      void refreshSources().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [available, processing]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return sources;
    return sources.filter((source) =>
      [source.title, source.originalFilename]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(normalized)),
    );
  }, [query, sources]);

  function resetComposer() {
    setTitle("");
    setContent("");
    setFile(null);
    setUploadProgress(0);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function addNote() {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    try {
      await jsonResponse(
        await fetch("/api/knowledge-sources/notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content }),
        }),
      );
      await refreshSources();
      setNoteOpen(false);
      resetComposer();
      toast.success("Note added to your knowledge");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not add note.");
    } finally {
      setBusy(false);
    }
  }

  async function addFile() {
    if (!file || !title.trim()) return;
    setBusy(true);
    setUploadProgress(1);
    try {
      const contentHash = await hashFile(file);
      const canonicalMimeType = canonicalKnowledgeMimeType(
        file.name,
        file.type,
      );
      const registration = await jsonResponse(
        await fetch("/api/knowledge-sources/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            filename: file.name,
            mimeType: canonicalMimeType,
            sizeBytes: file.size,
            contentHash,
          }),
        }),
      );
      if (registration.status !== "ready" && registration.signedUrl) {
        await uploadSignedFile(
          registration.signedUrl,
          file,
          canonicalMimeType,
          setUploadProgress,
        );
        await jsonResponse(
          await fetch("/api/knowledge-sources/uploads/complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceId: registration.sourceId,
              path: registration.path,
              contentHash,
            }),
          }),
        );
      }
      await refreshSources();
      setUploadOpen(false);
      resetComposer();
      toast.success(
        registration.status === "ready"
          ? "This file is already in your knowledge"
          : "File uploaded and processing",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not upload file.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function archiveSource(source: KnowledgeSourceSummary) {
    try {
      await jsonResponse(
        await fetch("/api/knowledge-sources", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId: source.id,
            expectedUpdatedAt: source.updatedAt,
          }),
        }),
      );
      setSources((current) =>
        current.filter((candidate) => candidate.id !== source.id),
      );
      toast.success("Source archived");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not archive source.",
      );
    }
  }

  if (!available) {
    return (
      <EmptyState
        icon={<LibraryBig className="size-7" />}
        title="Knowledge Library is being prepared"
        description="This page will become available after the final Knowledge Library database update is installed."
      />
    );
  }

  return (
    <>
      <Surface padding="sm" className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold">Private source library</h2>
            <p className="text-sm text-muted-foreground">
              Only your workspace and Cowork can use these sources.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button variant="outline" onClick={() => setNoteOpen(true)}>
              <NotebookPen />
              Add note
            </Button>
            <Button onClick={() => setUploadOpen(true)}>
              <FileUp />
              Upload file
            </Button>
          </div>
        </div>
        <Toolbar className="flex items-center gap-2 px-3">
          <Search className="size-4 text-muted-foreground" />
          <Input
            aria-label="Search knowledge"
            placeholder="Search your knowledge"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
        </Toolbar>
      </Surface>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<LibraryBig className="size-7" />}
          title={sources.length ? "No matching sources" : "Build your knowledge base"}
          description={
            sources.length
              ? "Try another search."
              : "Add call notes, customer research, frameworks, and documents Cowork should be able to draw from."
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((source) => {
            const active =
              source.status === "pending" || source.status === "processing";
            return (
              <Surface
                key={source.id}
                padding="sm"
                className="flex min-w-0 items-start gap-3"
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
                  {source.kind === "note" ? (
                    <NotebookPen className="size-5" />
                  ) : (
                    <FileText className="size-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">
                        {source.title}
                      </h3>
                      <p className="truncate text-xs text-muted-foreground">
                        {source.originalFilename ??
                          (source.kind === "note" ? "Pasted note" : "Document")}
                        {source.sizeBytes
                          ? ` · ${formatKnowledgeBytes(source.sizeBytes)}`
                          : ""}
                      </p>
                    </div>
                    <StatusPill
                      tone={
                        source.status === "ready"
                          ? "success"
                          : source.status === "failed"
                            ? "danger"
                            : "warning"
                      }
                    >
                      {source.status === "ready" ? (
                        <CheckCircle2 />
                      ) : source.status === "failed" ? (
                        <AlertCircle />
                      ) : (
                        <Loader2 className="animate-spin" />
                      )}
                      {source.status === "ready"
                        ? "Ready"
                        : source.status === "failed"
                          ? "Needs attention"
                          : "Processing"}
                    </StatusPill>
                  </div>
                  {source.status === "failed" && (
                    <p className="mt-2 text-xs leading-5 text-destructive">
                      {knowledgeFailureMessage(source.errorCode)}
                    </p>
                  )}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      Added{" "}
                      {formatKnowledgeDate(source.createdAt)}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={active}
                      onClick={() => void archiveSource(source)}
                      aria-label={`Archive ${source.title}`}
                    >
                      <Archive />
                      Archive
                    </Button>
                  </div>
                </div>
              </Surface>
            );
          })}
        </div>
      )}

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a note</DialogTitle>
            <DialogDescription>
              Paste durable context Cowork can use in future writing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="knowledge-note-title">Title</Label>
              <Input
                id="knowledge-note-title"
                maxLength={240}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Q3 customer interview themes"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="knowledge-note-content">Note</Label>
              <Textarea
                id="knowledge-note-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                maxLength={1_500_000}
                rows={12}
                placeholder="Paste the useful context here…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !title.trim() || !content.trim()}
              onClick={() => void addNote()}
            >
              {busy && <Loader2 className="animate-spin" />}
              Add note
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload a source</DialogTitle>
            <DialogDescription>
              PDF, DOCX, RTF, text, Markdown, CSV, TSV, JSON, or log files up to
              20 MB.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="knowledge-file-title">Title</Label>
              <Input
                id="knowledge-file-title"
                maxLength={240}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Customer research notes"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="knowledge-file">File</Label>
              <Input
                ref={fileInput}
                id="knowledge-file"
                type="file"
                accept=".pdf,.docx,.rtf,.txt,.md,.markdown,.csv,.tsv,.json,.log"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </div>
            {busy && (
              <div className="space-y-2" aria-live="polite">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Uploading securely</span>
                  <span>{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !file || !title.trim()}
              onClick={() => void addFile()}
            >
              {busy && <Loader2 className="animate-spin" />}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
