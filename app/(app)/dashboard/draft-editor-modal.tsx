"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useCopiedFlag } from "@/lib/use-copied-flag";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { copyToClipboard } from "@/lib/clipboard";
import { draftEgressBody } from "@/lib/markdown/mode";
import { LINKEDIN_MAX_CHARS } from "@/lib/linkedin-format";
import { localDateFromDatetimeInput } from "@/lib/schedule-local-date";
import {
  MessageSquare,
  Loader2,
  ChevronUp,
  ChevronDown,
  Copy,
  Check,
  Trash2,
  X,
  ListChecks,
  Calendar,
  CalendarClock,
  Send,
  Type,
  Eye,
  ExternalLink,
  Paperclip,
  UploadCloud,
  Image as ImageIcon,
  Video,
  File,
  ThumbsDown,
  ThumbsUp,
  Images,
  HardDrive,
  Magnet,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DraftEditor } from "./draft-editor";
import { LeadSharkPanel } from "./leadshark-panel";
import { cn } from "@/lib/utils";
import { POST_INTENTS } from "@/lib/post-intents";
import { AvatarImg } from "@/components/avatar-img";
import type { Draft, DraftStatus, DraftKind } from "@/lib/draft-view";
import { normalizeDraft } from "@/lib/draft-view";
import {
  MAX_LINKEDIN_IMAGES,
  mediaAttachmentsForPersistence,
  validatePostMediaFile,
  validatePostMediaSet,
  type PostMediaAttachment,
  type PostMediaType,
} from "@/lib/post-media";
import {
  NEGATIVE_FEEDBACK_REASONS,
  POSITIVE_FEEDBACK_REASONS,
  type ContentFeedbackRating,
  type ContentFeedbackReason,
} from "@/lib/content-feedback-catalog";

const FEEDBACK_REASON_LIMIT = 4;
// Vercel rejects multipart request bodies above its platform limit before our
// fallback route can return a useful response. Large files must stay on the
// direct, presigned-storage path.
const SERVER_UPLOAD_FALLBACK_MAX_BYTES = 4 * 1024 * 1024;

// The minimal lead-magnet shape the create-form picker needs: id to send, title
// to show. Comes from GET /api/lead-magnets (which returns the full LeadMagnet,
// but the picker only reads these two).
type LeadMagnetOption = { id: string; title: string };

export type PostPreviewAuthor = {
  name: string;
  avatarUrl: string | null;
  headline: string | null;
};

const DEFAULT_POST_PREVIEW_AUTHOR: PostPreviewAuthor = {
  name: "You",
  avatarUrl: null,
  headline: null,
};

const STATUS_OPTIONS: { value: DraftStatus; label: string }[] = [
  { value: "idea", label: "Ideas" },
  { value: "drafting", label: "Drafting" },
  { value: "ready", label: "Ready" },
  { value: "posted", label: "Posted" },
];
const STATUS_HELP: Record<DraftStatus, string> = {
  idea: "Ideas: a saved concept that still needs drafting.",
  drafting: "Drafting: work in progress, not ready to publish yet.",
  ready: "Ready: reviewed and ready to schedule or publish.",
  posted: "Posted: already published or archived as done.",
};

// The content type — what KIND of post this is (distinct from its pipeline
// status). "Regular Post" is the label for the internal 'post' value.
const KIND_OPTIONS: { value: DraftKind; label: string }[] = [
  { value: "post", label: "Regular Post" },
  { value: "lead_magnet", label: "Lead Magnet Post" },
  { value: "hook", label: "Hook" },
];
const KIND_HELP: Record<DraftKind, string> = {
  post: "Regular Post: a standard thought-leadership or engagement post.",
  lead_magnet: "Lead Magnet Post: designed to drive replies, signups, or interest.",
  hook: "Hook: a short opening idea or angle, not a full post yet.",
};

// The post detail drawer — a Notion-style panel that slides in from the right
// when a board card is opened. The board card itself is just the post name; all
// the editing lives here: preview name, status, due date, body, plus copy,
// delete, and the "Model in Chat" AI handoff.
//
// Two modes, decided by `draft`:
//   - existing post  → property changes PATCH immediately (optimistic via the
//     parent callbacks); the body saves on blur / explicit Save.
//   - new post (null) → nothing exists yet, so the body must be saved (POST)
//     before status/date/name editing or the AI handoff are meaningful. We show
//     a streamlined "write + create" state and unlock the rest after creation.
//
// All persistence funnels through the parent (onCreated / onSaved / onMeta /
// onDelete) so the board stays the single source of truth.

// Media attachments carry stable ids, so two lists are "the same set" when they
// hold the same ids in the same order. Used by persistMedia's reconciling
// rollback to tell "nothing else touched the media" from "a concurrent write
// landed" (in which case we must NOT blindly restore). Pure + exported for tests.
export function sameMediaAttachments(
  a: PostMediaAttachment[],
  b: PostMediaAttachment[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.id === b[i]?.id);
}

export function DraftEditorModal({
  open,
  onOpenChange,
  draft,
  author = DEFAULT_POST_PREVIEW_AUTHOR,
  onCreated,
  onSaved,
  onMeta,
  onDelete,
  onPrevious,
  onNext,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // null → creating a new post; otherwise editing this one.
  draft: Draft | null;
  author?: PostPreviewAuthor;
  onCreated: (draft: Draft) => void;
  onSaved: (id: string, body: string) => void;
  // Optimistic property change on an existing post (title / status / date).
  onMeta: (id: string, patch: Partial<Draft>) => void;
  onDelete: (id: string) => void;
  // Adjacent posts in the board's canonical ordering. They are omitted for a
  // new post and at either end of that ordering.
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const router = useRouter();
  const isNew = draft === null;
  // Live mirror of the `draft` prop so async handlers (persistMedia's rollback)
  // read the CURRENT media, not a stale closure snapshot — the lead-magnet
  // image worker can patch draft.mediaAttachments while a manual PATCH is in
  // flight, and a blind snapshot-restore would drop that image.
  const liveDraftRef = useRef(draft);
  const [body, setBody] = useState(draft?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [handing, setHanding] = useState(false);
  const [copied, markCopied] = useCopiedFlag();
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  // Gate the delete behind a confirm — deleting a draft is permanent (no undo /
  // no trash), so a mis-tap on the trash icon shouldn't nuke it silently.
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // Gate closing WITH unsaved body changes behind a confirm — closing the drawer
  // (X / Escape / backdrop) used to discard a dirty body silently.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<"previous" | "next" | null>(
    null,
  );

  useEffect(() => {
    liveDraftRef.current = draft;
  }, [draft]);

  // NEW-POST form state — a new post can now set status + planned date up front
  // (previously disabled until after create). Title uses titleDraft below. These
  // seed to sensible defaults each time the "New post" panel opens.
  const [newStatus, setNewStatus] = useState<DraftStatus>("drafting");
  const [newDate, setNewDate] = useState<string>("");
  // A new post's Kind. Empty (undefined) → the server auto-classifies from the
  // body; picking one makes it explicit (auto-classify then respects it).
  const [newKind, setNewKind] = useState<DraftKind | "">("");
  // The giveaway a new lead-magnet post hands out — only surfaced (and only sent)
  // when the Kind is "lead_magnet". "" = none chosen. Resolved server-side into
  // meta.lead_magnet so the board's Giveaway row + the comment-to-DM automation
  // both see the same resource.
  const [newLeadMagnetId, setNewLeadMagnetId] = useState<string>("");
  // The workspace's lead magnets, loaded lazily the first time the giveaway
  // picker is shown (a new lead-magnet post). null = not yet loaded.
  const [leadMagnetOptions, setLeadMagnetOptions] = useState<LeadMagnetOption[] | null>(null);
  const [leadMagnetsLoading, setLeadMagnetsLoading] = useState(false);

  // Lazily load the workspace's lead magnets the first time the giveaway picker
  // is actually shown (a NEW lead-magnet post). Loaded once per mount and cached
  // in state — reopening the modal or toggling Kind won't refetch. Errors leave
  // the list empty (the picker degrades to the "create one first" hint).
  const wantsLeadMagnets = open && isNew && newKind === "lead_magnet";
  useEffect(() => {
    if (!wantsLeadMagnets || leadMagnetOptions !== null || leadMagnetsLoading) return;
    let cancelled = false;
    // Flip the loading flag inside the async task (not synchronously in the
    // effect body) so the render-driven set-state stays out of the effect's
    // sync path.
    void (async () => {
      setLeadMagnetsLoading(true);
      try {
        const data = await fetchJson<{
          ok: boolean;
          error?: string;
          leadMagnets?: { id: string; title: string }[];
        }>("/api/lead-magnets");
        if (cancelled) return;
        if (!data.ok) throw new Error(data.error || "Couldn't load lead magnets.");
        setLeadMagnetOptions(
          (data.leadMagnets ?? []).map((m) => ({ id: m.id, title: m.title })),
        );
      } catch (e) {
        if (cancelled) return;
        setLeadMagnetOptions([]);
        toast.error((e as Error).message);
      } finally {
        if (!cancelled) setLeadMagnetsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantsLeadMagnets, leadMagnetOptions, leadMagnetsLoading]);

  const [newMedia, setNewMedia] = useState<PostMediaAttachment[]>([]);
  // Temporary attachments render a local preview while the canonical upload is
  // in flight. They never enter `newMedia` or a persistence payload.
  const [pendingMedia, setPendingMedia] = useState<PostMediaAttachment[]>([]);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const uploadingMediaRef = useRef(false);
  const inFlightUploadEvents = useRef(new Map<string, number>());
  const cancelledPendingMedia = useRef(new Set<string>());
  const uploadSessionRef = useRef(0);
  const pendingPreviewUrls = useRef(new Map<string, string>());
  const [mediaLibraryOpen, setMediaLibraryOpen] = useState(false);

  // Re-seed on open / draft change (state-during-render, keyed on `open` so a
  // close+reopen of the same post re-reads its body and never shows stale text).
  const [seed, setSeed] = useState<string | null>(null);
  const seedKey = open ? `open:${draft?.id ?? "__new__"}` : "__closed__";
  if (seed !== seedKey) {
    setSeed(seedKey);
    setPendingMedia([]);
    setUploadingMedia(false);
    if (open) {
      setBody(draft?.body ?? "");
      // Reset the new-post fields when the panel (re)opens onto a new post.
      if (!draft) {
        setNewStatus("drafting");
        setNewDate("");
        setNewKind("");
        setNewLeadMagnetId("");
        setNewMedia([]);
      }
      setMode("edit");
    }
  }

  // A pending request may still finish after a close/reopen. Advancing the
  // session prevents it from attaching media to a fresh editor instance. This
  // runs after the open/draft transition commits, never while rendering.
  useEffect(() => {
    for (const previewUrl of pendingPreviewUrls.current.values()) {
      URL.revokeObjectURL(previewUrl);
    }
    pendingPreviewUrls.current.clear();
    uploadSessionRef.current += 1;
    inFlightUploadEvents.current.clear();
    cancelledPendingMedia.current.clear();
    uploadingMediaRef.current = false;
  }, [seedKey]);

  const trimmed = body.trim();
  const linkedInBody = draftEgressBody(body, draft?.meta);
  const dirty = trimmed !== (draft?.body ?? "").trim();
  const mediaAttachments = isNew ? newMedia : draft?.mediaAttachments ?? [];
  const displayedMedia = [...mediaAttachments, ...pendingMedia];
  const busy = saving || handing;
  const paragraphCount = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).length;
  const saveState = saving
    ? "Saving..."
    : isNew
      ? "Not created yet"
      : dirty
        ? "Unsaved changes"
        : "Saved";

  // ---- persistence -----------------------------------------------------------

  // Save the body (create on new, PATCH on existing). Returns the post id or
  // null. Shared by Save and the Model-in-Chat handoff (which needs an id).
  const persistBody = async (): Promise<string | null> => {
    // A NEW post can be saved with an empty body as long as it has a name — you
    // set the card up now (name/status/date) and write the body later. An
    // existing post still needs content to save meaningfully.
    const newName = titleDraft.trim();
    if (isNew ? !trimmed && !newName : !trimmed) {
      toast.error(isNew ? "Give the post a name or some content." : "Write something first.");
      return null;
    }
    try {
      if (isNew) {
        const res = await fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            body: trimmed,
            ...(newName ? { title: newName } : {}),
            status: newStatus,
            plan_to_post_on: newDate || null,
            // Only send an explicit kind when the user picked one; otherwise the
            // server auto-classifies (regular vs lead-magnet) from the body.
            ...(newKind ? { kind: newKind } : {}),
            // The chosen giveaway — only meaningful (and only sent) for a
            // lead-magnet post. The server ignores it for other kinds.
            ...(newKind === "lead_magnet" && newLeadMagnetId
              ? { lead_magnet_id: newLeadMagnetId }
              : {}),
            ...(newMedia.length
              ? { media_attachments: mediaAttachmentsForPersistence(newMedia) }
              : {}),
          }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to create post");
        onCreated(normalizeDraft(data.draft));
        return data.draft.id as string;
      }
      if (!dirty) return draft!.id;
      const res = await fetch(`/api/drafts/${draft!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(draft!.id, trimmed);
      return draft!.id;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  };

  const save = async () => {
    if (busy) return;
    if (uploadingMedia) {
      toast.error("Wait for the media upload to finish before saving.");
      return;
    }
    setSaving(true);
    const id = await persistBody();
    setSaving(false);
    if (id) {
      toast.success(isNew ? "Post created" : "Post saved");
      // Close on every successful save — new or existing — so the action has
      // one consistent outcome (the board reflects the change immediately).
      onOpenChange(false);
    }
  };

  const createAndSchedule = async (input: ScheduleInput) => {
    if (busy) return;
    if (uploadingMedia) {
      toast.error("Wait for the media upload to finish before scheduling.");
      return;
    }
    setSaving(true);
    const id = await persistBody();
    if (!id) {
      setSaving(false);
      return;
    }
    try {
      const data = await scheduleDraft(id, input);
      onMeta(id, {
        scheduledAt: data.scheduledAt ?? input.scheduledAt,
        scheduleStatus: "scheduled",
        planToPostOn: data.planToPostOn ?? input.planToPostOn,
        firstComment: data.firstComment ?? null,
        publishError: null,
      });
      toast.success("Post created and scheduled on LinkedIn.");
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // A property change (title / status / date) on an EXISTING post. Optimistic via
  // onMeta; PATCH in the background. New posts can't have properties yet (no id),
  // so these controls are disabled until the body is created.
  const patchMeta = async (patch: Partial<Draft>, body: Record<string, unknown>) => {
    if (isNew || !draft) return;
    onMeta(draft.id, patch); // optimistic
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copy = async () => {
    // For a markdown-model draft, copy the LinkedIn-ready form (matches publish
    // and the card copy). `trimmed` is the live-edited body; fall back to the
    // saved body. draftEgressBody is a no-op unless meta.markdown is set.
    const raw = trimmed || draft?.body || "";
    if (
      await copyToClipboard(
        draftEgressBody(raw, draft?.meta),
        "Copied to clipboard",
      )
    ) {
      markCopied();
    }
  };

  const persistMedia = async (next: PostMediaAttachment[]) => {
    if (isNew || !draft) {
      setNewMedia(next);
      return true;
    }
    const previous = mediaAttachments;
    onMeta(draft.id, { mediaAttachments: next });
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_attachments: mediaAttachmentsForPersistence(next) }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update media");
      return true;
    } catch (e) {
      // Reconcile, don't restore: only revert to `previous` if the CURRENT
      // media is still exactly the `next` we optimistically set. If something
      // else changed it during the await (the lead-magnet image worker landing
      // an attachment, another edit), leave that alone — a blind restore would
      // clobber it. Compares the live draft, not the stale closure snapshot.
      const current = liveDraftRef.current?.mediaAttachments ?? [];
      if (sameMediaAttachments(current, next)) {
        onMeta(draft.id, { mediaAttachments: previous });
      }
      toast.error((e as Error).message);
      return false;
    }
  };

  const addMediaFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files);
    const eventKey = selected
      .map((file) => `${file.name}:${file.type}:${file.size}:${file.lastModified}`)
      .sort()
      .join("|");
    if (
      selected.length === 0 ||
      uploadingMediaRef.current ||
      inFlightUploadEvents.current.has(eventKey)
    ) {
      return;
    }
    const uploadSession = uploadSessionRef.current;
    inFlightUploadEvents.current.set(eventKey, uploadSession);
    uploadingMediaRef.current = true;
    let next = [...mediaAttachments];
    setUploadingMedia(true);
    try {
      for (const file of selected) {
        const validation = validatePostMediaFile({
          name: file.name,
          contentType: file.type,
          size: file.size,
        });
        if (!validation.ok) throw new Error(validation.error);
        const setError = validatePostMediaSet([
          ...next,
          {
            id: "pending",
            name: file.name,
            mimeType: validation.normalizedContentType,
            size: file.size,
            type: validation.type,
            url: "https://media.zernio.com/temp/pending",
            uploadedAt: new Date().toISOString(),
          },
        ]);
        if (setError) throw new Error(setError);

        const pendingId = crypto.randomUUID();
        const previewUrl = validation.type === "image" ? URL.createObjectURL(file) : undefined;
        const pendingAttachment: PostMediaAttachment = {
          id: pendingId,
          name: file.name,
          mimeType: validation.normalizedContentType,
          size: file.size,
          type: validation.type,
          url: null,
          previewUrl,
          uploadedAt: new Date().toISOString(),
        };
        if (previewUrl) pendingPreviewUrls.current.set(pendingId, previewUrl);
        // Render a local object URL before asking the provider for a presign so
        // a slow upload never leaves the post preview blank.
        setPendingMedia((current) => [...current, pendingAttachment]);

        const presignRes = await fetchJson<{
          ok: boolean;
          error?: string;
          uploadUrl?: string;
          publicUrl?: string;
          key?: string | null;
          type?: PostMediaType;
          contentType?: string;
        }>("/api/zernio/media/presign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: validation.normalizedContentType,
            size: file.size,
          }),
        });
        if (!presignRes.ok || !presignRes.uploadUrl || !presignRes.publicUrl) {
          throw new Error(presignRes.error || "Couldn't prepare media upload.");
        }
        let publicUrl = presignRes.publicUrl;
        let key = presignRes.key ?? null;
        try {
          await uploadMediaDirectly(file, presignRes.uploadUrl, validation.normalizedContentType);
        } catch {
          // A freshly-issued URL handles an expired/one-shot presign without
          // proxying the file through our server.
          const retry = await requestMediaPresign(file, validation.normalizedContentType);
          publicUrl = retry.publicUrl;
          key = retry.key;
          try {
            await uploadMediaDirectly(file, retry.uploadUrl, validation.normalizedContentType);
          } catch {
            if (file.size > SERVER_UPLOAD_FALLBACK_MAX_BYTES) {
              throw new Error("Direct upload failed. Please try again; large files cannot be proxied through the app.");
            }
            const fallback = await uploadMediaViaServer(file);
            publicUrl = fallback.publicUrl;
            key = fallback.key;
          }
        }
        if (
          uploadSession !== uploadSessionRef.current ||
          cancelledPendingMedia.current.has(pendingId)
        ) {
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          pendingPreviewUrls.current.delete(pendingId);
          continue;
        }
        pendingPreviewUrls.current.delete(pendingId);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        next = [
          ...next,
          {
            id: pendingId,
            name: file.name,
            mimeType: validation.normalizedContentType,
            size: file.size,
            type: validation.type,
            url: publicUrl,
            key,
            uploadedAt: new Date().toISOString(),
          },
        ];
        // The temporary preview now gives way to the stable provider URL while
        // the final canonical attachment is persisted below.
        setPendingMedia((current) =>
          current.map((attachment) =>
            attachment.id === pendingId
              ? { ...attachment, url: publicUrl, key, previewUrl: undefined }
              : attachment,
          ),
        );
      }
      if (uploadSession === uploadSessionRef.current) {
        const finalAttachments = next.filter(
          (attachment) => !cancelledPendingMedia.current.has(attachment.id),
        );
        // `persistMedia` updates the canonical draft/new-post state
        // optimistically. Drop the temporary display entries first so the
        // successful image is never rendered twice during that update.
        setPendingMedia([]);
        if (await persistMedia(finalAttachments)) {
          toast.success("Media attached");
        }
      }
    } catch (e) {
      // Never leave a broken temporary attachment behind after a failure. The
      // user's draft text and already-uploaded attachments are left intact.
      if (uploadSession === uploadSessionRef.current) {
        for (const previewUrl of pendingPreviewUrls.current.values()) {
          URL.revokeObjectURL(previewUrl);
        }
        pendingPreviewUrls.current.clear();
        setPendingMedia([]);
        toast.error((e as Error).message);
      }
    } finally {
      if (inFlightUploadEvents.current.get(eventKey) === uploadSession) {
        inFlightUploadEvents.current.delete(eventKey);
      }
      if (uploadSession === uploadSessionRef.current) {
        uploadingMediaRef.current = false;
        setUploadingMedia(false);
      }
    }
  };

  const addLibraryMedia = async (assets: MediaLibraryAsset[]) => {
    const next = [...mediaAttachments, ...assets.map(mediaAssetAttachment)];
    const setError = validatePostMediaSet(next);
    if (setError) {
      toast.error(setError);
      return;
    }
    if (await persistMedia(next)) {
      toast.success(assets.length === 1 ? "Media attached" : "Media attached");
    }
  };

  const removeMedia = (id: string) => {
    const pending = pendingMedia.find((attachment) => attachment.id === id);
    if (pending) {
      // A presigned PUT may not be abortable, but its result must never return
      // to the post after the user has removed the temporary preview.
      cancelledPendingMedia.current.add(id);
      const previewUrl = pendingPreviewUrls.current.get(id) ?? pending.previewUrl;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      pendingPreviewUrls.current.delete(id);
      setPendingMedia((current) => current.filter((attachment) => attachment.id !== id));
      return;
    }
    const next = mediaAttachments.filter((m) => m.id !== id);
    void persistMedia(next);
  };

  // The trash icon: a NEW (unsaved) post has nothing to delete — just close. An
  // existing draft opens a confirm first (delete is permanent + undoable-only-by-
  // re-writing), and the actual delete runs in confirmRemove on confirm.
  const remove = () => {
    if (isNew || !draft) {
      onOpenChange(false);
      return;
    }
    setConfirmDeleteOpen(true);
  };

  const confirmRemove = () => {
    if (!draft) return;
    onDelete(draft.id);
    onOpenChange(false);
  };

  // "Model in Chat": save the post (need a draft id), stash it as a modeling
  // source (source: 'draft'), then open the chat at ?model=<id>&intent=refine —
  // the SAME flow as the swipe-file / bookmark "Model in Chat", so the chat shows
  // the source chip above a clean composer instead of stuffing a refine blob in.
  const modelInChat = async () => {
    if (busy) return;
    if (uploadingMedia) {
      toast.error("Wait for the media upload to finish before continuing.");
      return;
    }
    setHanding(true);
    const id = await persistBody();
    if (!id) {
      setHanding(false);
      return;
    }
    try {
      const res = await fetch("/api/model-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "draft", postId: id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Couldn't open this post in chat");
      router.push(
        `/dashboard?model=${encodeURIComponent(data.id)}&intent=${POST_INTENTS.refine.key}&handoff=${encodeURIComponent(data.id)}`,
      );
    } catch (e) {
      toast.error((e as Error).message);
      setHanding(false);
    }
  };

  // Local title state mirrors the draft; commits on blur / Enter. Re-seeded
  // alongside the body when the panel opens onto a post (same seedKey gate).
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSeed, setTitleSeed] = useState<string | null>(null);
  if (titleSeed !== seedKey) {
    setTitleSeed(seedKey);
    if (open) setTitleDraft(draft?.title ?? "");
  }
  const commitTitle = () => {
    if (isNew || !draft) return;
    const next = titleDraft.trim();
    if (next === (draft.title ?? "").trim()) return;
    void patchMeta({ title: next || null }, { title: next });
  };

  // Whether the title input has an uncommitted change (only commits on blur, so
  // an X/Escape/backdrop close would drop it — bug #6). For a NEW post the title
  // rides into persistBody() directly, so it's never "pending" here.
  const titlePending =
    !isNew && !!draft && titleDraft.trim() !== (draft.title ?? "").trim();

  // The single close path every trigger (X button, Escape, backdrop) routes
  // through, so pending edits are never dropped silently:
  //   • Flush a pending title edit (it only auto-commits on blur — bug #6).
  //   • If the BODY has unsaved changes, confirm before discarding (bug #7).
  // A NEW post is exempt from the body guard — it's a create-or-discard scratch
  // draft, and closing it is the expected "cancel", not a data-loss surprise.
  const requestClose = () => {
    if (busy) return;
    if (titlePending) commitTitle();
    if (!isNew && dirty) {
      setConfirmDiscardOpen(true);
      return;
    }
    onOpenChange(false);
  };

  // Switching posts must be as safe as closing the editor: a title is flushed,
  // while an unsaved body gets an explicit discard confirmation instead of
  // silently being replaced by the adjacent post.
  const requestNavigate = (direction: "previous" | "next") => {
    const navigate = direction === "previous" ? onPrevious : onNext;
    if (busy || !navigate) return;
    if (titlePending) commitTitle();
    if (dirty) {
      setPendingNavigation(direction);
      setConfirmDiscardOpen(true);
      return;
    }
    navigate();
  };

  const discardAndContinue = () => {
    const navigation = pendingNavigation;
    setPendingNavigation(null);
    setConfirmDiscardOpen(false);
    if (navigation === "previous") onPrevious?.();
    else if (navigation === "next") onNext?.();
    else onOpenChange(false);
  };

  const setDiscardDialogOpen = (nextOpen: boolean) => {
    setConfirmDiscardOpen(nextOpen);
    if (!nextOpen) setPendingNavigation(null);
  };

  return (
    <>
    <Dialog
      open={open}
      // Escape + backdrop close route through requestClose so a pending title
      // is flushed and a dirty body is confirmed before discarding. A programmatic
      // open (v === true) still passes straight through.
      onOpenChange={(v) => {
        if (busy) return;
        if (v) onOpenChange(true);
        else requestClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // Wide editor-first drawer: the post body owns the main column, while
        // status/scheduling/media live in a secondary rail.
        className="left-auto right-0 top-0 bottom-0 h-[100dvh] max-h-[100dvh] w-full translate-x-0 translate-y-0 gap-0 rounded-none border-l border-border bg-card p-0 shadow-soft-lg sm:max-w-[min(1120px,94vw)] lg:rounded-l-[1.15rem] xl:max-w-[1180px] data-open:slide-in-from-right-4 data-closed:slide-out-to-right-4 duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card/90 px-4 py-3 backdrop-blur sm:px-5">
          <button
            type="button"
            onClick={requestClose}
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">
                {isNew ? "New post" : "Edit post"}
              </span>
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  saving
                    ? "border-primary/20 bg-primary/10 text-primary"
                    : dirty
                      ? "border-state-warning-border bg-state-warning-bg text-state-warning"
                      : "border-state-success-border bg-state-success-bg text-state-success",
                )}
              >
                {saveState}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {!isNew && (
              <div className="mr-1 flex items-center gap-0.5 border-r border-border pr-2">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-foreground disabled:text-muted-foreground/30 disabled:opacity-100"
                  onClick={() => requestNavigate("previous")}
                  disabled={!onPrevious || busy}
                  aria-label="Previous post"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-foreground disabled:text-muted-foreground/30 disabled:opacity-100"
                  onClick={() => requestNavigate("next")}
                  disabled={!onNext || busy}
                  aria-label="Next post"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={copy}
              disabled={!trimmed && !draft}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted-foreground hover:text-destructive"
              onClick={remove}
              aria-label="Delete post"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <DialogTitle className="sr-only">
          {isNew ? "New post" : "Edit post"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Edit the post body, preview name, status, and planning date.
        </DialogDescription>

        <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
          <div className="grid min-h-full lg:h-full lg:grid-cols-[minmax(0,1fr)_340px]">
            <main className="min-w-0 overflow-visible px-4 py-5 sm:px-6 lg:overflow-y-auto lg:px-8 lg:py-7">
              <div className="mx-auto flex max-w-[760px] flex-col gap-5">
                <div className="space-y-3">
                  <input
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder={isNew ? "Name your post..." : "Untitled post"}
                    className="w-full bg-transparent text-3xl font-semibold leading-tight tracking-tight text-foreground outline-none placeholder:text-muted-foreground/45 sm:text-4xl"
                    aria-label="Preview name"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <EditorStat label="Characters" value={linkedInBody.length.toLocaleString()} />
                      <EditorStat label="Paragraphs" value={paragraphCount.toLocaleString()} />
                    </div>
                    <div className="inline-flex rounded-full border border-border bg-card/80 p-0.5 shadow-soft">
                      <button
                        type="button"
                        onClick={() => setMode("edit")}
                        className={cn(
                          "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                          mode === "edit"
                            ? "bg-foreground text-background shadow-soft"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Type className="h-3.5 w-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode("preview")}
                        className={cn(
                          "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                          mode === "preview"
                            ? "bg-foreground text-background shadow-soft"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        Preview
                      </button>
                    </div>
                  </div>
                </div>

                {mode === "edit" ? (
                  <div className="rounded-xl border border-border bg-card/90 p-3 shadow-soft">
                    <DraftEditor
                      value={body}
                      onChange={setBody}
                      onMediaFiles={addMediaFiles}
                      allowImagePaste={isNew}
                      rows={22}
                      textareaClassName="min-h-[52vh] rounded-xl border-transparent bg-transparent px-2 py-2 text-[15px] leading-8 shadow-none focus-visible:border-primary/20 focus-visible:ring-primary/10"
                    />
                  </div>
                ) : (
                  <LinkedInPostPreview
                    author={author}
                    body={linkedInBody}
                    attachments={displayedMedia}
                  />
                )}
              </div>
            </main>

            <aside className="border-t border-border bg-card/70 px-4 py-5 sm:px-6 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:px-4">
              <div className="mx-auto flex max-w-[760px] flex-col gap-4 lg:max-w-none">
                <section className="rounded-lg border border-border bg-background/72 p-3 shadow-soft">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold tracking-tight">Post settings</h3>
                      <p className="text-xs text-muted-foreground">
                        Board stage, calendar plan, and format.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <PropRow icon={<ListChecks className="h-4 w-4" />} label="Status">
                      <Select
                        value={isNew ? newStatus : (draft?.status ?? "idea")}
                        onValueChange={(v) => {
                          const status = v as DraftStatus;
                          if (isNew) setNewStatus(status);
                          else patchMeta({ status }, { status });
                        }}
                      >
                        <SelectTrigger
                          className="-ml-1 h-8 border-transparent px-1 hover:bg-accent focus-visible:bg-accent"
                          aria-label="Status"
                          title={STATUS_HELP[isNew ? newStatus : (draft?.status ?? "idea")]}
                        >
                          <SelectValue>
                            {(v) => STATUS_OPTIONS.find((s) => s.value === v)?.label ?? v}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_OPTIONS.map((s) => (
                            <SelectItem key={s.value} value={s.value}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </PropRow>

                    <PropRow icon={<Calendar className="h-4 w-4" />} label="Planning date">
                      <input
                        type="date"
                        value={isNew ? newDate : (draft?.planToPostOn ?? "")}
                        onChange={(e) => {
                          const v = e.target.value || null;
                          if (isNew) setNewDate(e.target.value);
                          else patchMeta({ planToPostOn: v }, { plan_to_post_on: v });
                        }}
                        className="-ml-1 h-8 rounded-md bg-transparent px-1 text-sm text-muted-foreground outline-none hover:bg-accent focus:bg-accent disabled:opacity-60"
                        aria-label="Planning date"
                        title="A planning date for your content calendar. This does not publish to LinkedIn."
                      />
                    </PropRow>

                    <PropRow icon={<Type className="h-4 w-4" />} label="Kind">
                      <Select
                        value={isNew ? newKind || "auto" : (draft?.kind ?? "post")}
                        onValueChange={(v) => {
                          if (isNew) setNewKind(v === "auto" ? "" : (v as DraftKind));
                          else patchMeta({ kind: v as DraftKind }, { kind: v as DraftKind });
                        }}
                      >
                        <SelectTrigger
                          className="-ml-1 h-8 border-transparent px-1 hover:bg-accent focus-visible:bg-accent"
                          aria-label="Kind"
                          title={
                            isNew && !newKind
                              ? "Auto: the app will classify the post type from the content."
                              : KIND_HELP[(isNew ? newKind || "post" : draft?.kind ?? "post") as DraftKind]
                          }
                        >
                          <SelectValue>
                            {(v) =>
                              v === "auto"
                                ? "Auto (from content)"
                                : (KIND_OPTIONS.find((k) => k.value === v)?.label ?? v)
                            }
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {isNew && <SelectItem value="auto">Auto (from content)</SelectItem>}
                          {KIND_OPTIONS.map((k) => (
                            <SelectItem key={k.value} value={k.value}>
                              {k.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </PropRow>

                    {/* NEW lead-magnet post → pick the resource to give away.
                        The choice is resolved server-side into meta.lead_magnet,
                        which drives the board's Giveaway row and the comment-to-DM
                        automation. Only shown for a new lead-magnet post; existing
                        drafts show the read-only row below. */}
                    {isNew && newKind === "lead_magnet" && (
                      <PropRow icon={<Magnet className="h-4 w-4" />} label="Giveaway">
                        {leadMagnetsLoading && leadMagnetOptions === null ? (
                          <span className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Loading…
                          </span>
                        ) : leadMagnetOptions && leadMagnetOptions.length > 0 ? (
                          <Select
                            value={newLeadMagnetId || "none"}
                            onValueChange={(v) =>
                              setNewLeadMagnetId(!v || v === "none" ? "" : v)
                            }
                          >
                            <SelectTrigger
                              className="-ml-1 h-8 border-transparent px-1 hover:bg-accent focus-visible:bg-accent"
                              aria-label="Giveaway"
                              title="The lead magnet resource this post gives away."
                            >
                              <SelectValue>
                                {(v) =>
                                  v === "none"
                                    ? "None"
                                    : (leadMagnetOptions.find((m) => m.id === v)?.title ??
                                      "None")
                                }
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {leadMagnetOptions.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.title}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <a
                            href="/dashboard/lead-magnets"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-1 text-sm text-primary hover:underline"
                          >
                            Create a lead magnet
                            <ExternalLink className="h-3 w-3" aria-hidden />
                          </a>
                        )}
                      </PropRow>
                    )}

                    {draft?.leadMagnet && (
                      <PropRow icon={<Magnet className="h-4 w-4" />} label="Giveaway">
                        <span
                          className="flex min-w-0 items-center gap-1 px-1 text-sm text-muted-foreground"
                          title={`Lead magnet giveaway: ${draft.leadMagnet.title}`}
                        >
                          <span className="min-w-0 truncate">{draft.leadMagnet.title}</span>
                        </span>
                      </PropRow>
                    )}

                    {draft?.sourceUrl && (
                      <PropRow icon={<ExternalLink className="h-4 w-4" />} label="Source">
                        <a
                          href={draft.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-1 text-sm text-primary hover:underline"
                        >
                          View original
                          <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      </PropRow>
                    )}
                  </div>
                </section>

                <ScheduleRow
                  draft={draft}
                  onMeta={onMeta}
                  onCreateAndSchedule={isNew ? createAndSchedule : undefined}
                  previewBody={isNew ? body : undefined}
                  previewMedia={isNew ? displayedMedia : undefined}
                  mediaUploading={uploadingMedia}
                />

                {!isNew && draft && draft.kind === "lead_magnet" && (
                  <LeadSharkPanel draft={draft} />
                )}

                <PostMediaSection
                  attachments={displayedMedia}
                  uploading={uploadingMedia}
                  pendingMediaIds={new Set(pendingMedia.map((attachment) => attachment.id))}
                  onAdd={addMediaFiles}
                  onOpenLibrary={() => setMediaLibraryOpen(true)}
                  onRemove={removeMedia}
                />

                {!isNew && draft && <PostFeedbackMemory draft={draft} body={body} />}
              </div>
            </aside>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-card/90 px-4 py-3 backdrop-blur sm:px-5">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={modelInChat}
            disabled={busy || !trimmed}
            title="Open this post in the chat and refine it with AI"
          >
            {handing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare className="h-3.5 w-3.5" />
            )}
            {handing ? "Opening…" : "Model with Cowork"}
          </Button>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={save}
              // New post: creatable with a name OR body (empty body is allowed).
              // Existing: needs body content + an actual change.
              disabled={
                busy ||
                uploadingMedia ||
                (isNew
                  ? !trimmed && !titleDraft.trim()
                  : !trimmed || !dirty)
              }
            >
              {saving || uploadingMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {saving ? "Saving..." : uploadingMedia ? "Uploading media..." : isNew ? "Create post" : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={confirmDeleteOpen}
      onOpenChange={setConfirmDeleteOpen}
      title="Delete this post?"
      description="This permanently removes the draft from your board. This can't be undone."
      confirmLabel="Delete"
      variant="destructive"
      onConfirm={confirmRemove}
    />
    <ConfirmDialog
      open={confirmDiscardOpen}
      onOpenChange={setDiscardDialogOpen}
      title="Discard unsaved changes?"
      description={
        pendingNavigation
          ? "You've edited this post but haven't saved. Moving to another post will lose those changes."
          : "You've edited this post but haven't saved. Closing now will lose those changes."
      }
      confirmLabel="Discard"
      variant="destructive"
      onConfirm={discardAndContinue}
    />
    <MediaLibraryDialog
      open={mediaLibraryOpen}
      onOpenChange={setMediaLibraryOpen}
      currentAttachments={mediaAttachments}
      onSelect={addLibraryMedia}
    />
    </>
  );
}

function EditorStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-card/70 px-2 py-1">
      <span className="font-medium tabular-nums text-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

const LINKEDIN_PREVIEW_HEADLINE_TEASER_CHARS = 41;

function linkedInPreviewHeadlineTeaser(headline: string): string {
  const trimmed = headline.trim();
  if (trimmed.length <= LINKEDIN_PREVIEW_HEADLINE_TEASER_CHARS) return trimmed;
  return `${trimmed.slice(0, LINKEDIN_PREVIEW_HEADLINE_TEASER_CHARS).trimEnd()}...`;
}

function LinkedInPostPreview({
  author,
  body,
  attachments,
}: {
  author: PostPreviewAuthor;
  body: string;
  attachments: PostMediaAttachment[];
}) {
  const text = body.trim();
  const initials = author.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  const headlineTeaser = author.headline
    ? linkedInPreviewHeadlineTeaser(author.headline)
    : null;
  return (
    <section className="mx-auto w-full max-w-[552px] rounded-xl border border-border bg-white p-5 shadow-soft">
      <div className="mb-4 flex items-center gap-3">
        <AvatarImg
          src={author.avatarUrl}
          className="h-11 w-11 shrink-0 rounded-xl object-cover"
          fallback={
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-sm font-semibold text-primary">
              {initials || "in"}
            </div>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold leading-tight">{author.name}</div>
          {headlineTeaser && (
            <div
              className="truncate text-xs text-muted-foreground"
              title={author.headline ?? undefined}
            >
              {headlineTeaser}
            </div>
          )}
          <div className="text-xs text-muted-foreground">now · LinkedIn preview</div>
        </div>
      </div>
      <div className="whitespace-pre-wrap text-[15px] leading-8 text-foreground">
        {text || (
          <span className="text-muted-foreground">
            Start writing in Edit mode to preview the post here.
          </span>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="mt-5 grid gap-2">
          {attachments[0]?.type === "image" && attachments.some((a) => a.previewUrl || a.url) && (
            <div className={cn(
              "grid gap-2 overflow-hidden rounded-xl border border-border bg-muted/30 p-2",
              attachments.length === 1 ? "grid-cols-1" : "grid-cols-2",
            )}>
              {attachments.slice(0, 4).map((attachment) => {
                const src = attachment.previewUrl || attachment.url;
                if (!src) return null;
                return (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={attachment.id}
                    src={src}
                    alt=""
                    className="aspect-[4/3] w-full rounded-lg object-cover"
                  />
                );
              })}
            </div>
          )}
          {/* File rows cover only what the image grid above doesn't already
              show — images with a preview render in the grid, everything else
              (and preview-less items) gets a row here. */}
          {(attachments[0]?.type === "image" && attachments.some((a) => a.previewUrl || a.url)
            ? attachments.filter((a) => a.type !== "image" || (!a.previewUrl && !a.url))
            : attachments
          ).slice(0, 4).map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2 text-sm"
            >
              <span className="text-muted-foreground">{mediaIcon(attachment.type)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{attachment.name}</div>
                <div className="text-xs text-muted-foreground">
                  {mediaTypeLabel(attachment.type)} attachment
                </div>
              </div>
            </div>
          ))}
          {attachments.length > 4 && (
            <div className="text-xs text-muted-foreground">
              +{attachments.length - 4} more attachment{attachments.length - 4 === 1 ? "" : "s"}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function PostFeedbackMemory({ draft, body }: { draft: Draft; body: string }) {
  const [openRating, setOpenRating] = useState<ContentFeedbackRating | null>(null);
  const [selected, setSelected] = useState<ContentFeedbackReason[]>([]);
  const [saving, setSaving] = useState(false);
  const [savedRating, setSavedRating] = useState<ContentFeedbackRating | null>(null);
  const [phrase, setPhrase] = useState("");
  // Free-form note — chips are quick picks; the user's own take teaches
  // Cowork opinions the AI would never infer. Saved with the feedback and
  // injected into future writer prompts via the feedback-memory block.
  const [note, setNote] = useState("");

  const reasons =
    openRating === "up"
      ? POSITIVE_FEEDBACK_REASONS
      : openRating === "down"
        ? NEGATIVE_FEEDBACK_REASONS
        : [];
  const phraseSelected = selected.includes("Don't use this phrase");

  const chooseRating = (next: ContentFeedbackRating) => {
    const changed = openRating !== next;
    setOpenRating(changed ? next : null);
    if (changed) {
      setSelected([]);
      setPhrase("");
      setNote("");
      setSavedRating(null);
    }
  };

  const toggleReason = (reason: ContentFeedbackReason) => {
    if (selected.includes(reason)) {
      setSelected(selected.filter((selectedReason) => selectedReason !== reason));
      return;
    }
    if (selected.length >= FEEDBACK_REASON_LIMIT) {
      toast.error(`Pick up to ${FEEDBACK_REASON_LIMIT} feedback chips.`);
      return;
    }
    setSelected([...selected, reason]);
  };

  const saveFeedback = async (
    rating: ContentFeedbackRating,
    reasonsToSave: ContentFeedbackReason[],
    options: { toastSuccess?: boolean } = {},
  ) => {
    const snapshot = body.trim();
    if (!snapshot) {
      toast.error("Write something first.");
      return false;
    }
    // A chip OR a free-form note is enough — free text alone is valid feedback.
    if (reasonsToSave.length === 0 && !note.trim()) {
      toast.error("Pick a chip or write a quick note.");
      return false;
    }
    setSaving(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/content-feedback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rating,
            reasons: reasonsToSave,
            bodySnapshot: snapshot,
            draftId: draft.id,
            chatId: draft.chatId,
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        },
      );
      if (!data.ok) throw new Error(data.error || "Couldn't save feedback.");
      setSavedRating(rating);
      setOpenRating(null);
      setSelected([]);
      setPhrase("");
      setNote("");
      if (options.toastSuccess ?? true) toast.success("Saved feedback");
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const savePhraseRule = async () => {
    const value = phrase.trim();
    if (!value) {
      toast.error("Add the phrase Cowork should avoid.");
      return;
    }
    setSaving(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/preferences",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rule: `Never say "${value}"` }),
        },
      );
      if (!data.ok && data.error !== "You already have that preference.") {
        throw new Error(data.error || "Couldn't save memory rule.");
      }
      const saved = await saveFeedback("down", selected, { toastSuccess: false });
      if (saved) {
        toast.success("Saved to memory");
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveSelectedFeedback = async () => {
    if (!openRating || saving) return;
    if (phraseSelected) {
      await savePhraseRule();
      return;
    }
    await saveFeedback(openRating, selected);
  };

  return (
    <section className="rounded-lg border border-border bg-background/72 p-3 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium tracking-tight">Memory feedback</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Teach Cowork what to repeat or avoid in future posts.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 rounded-full gap-1.5 border transition-colors",
              openRating === "up"
                ? "border-state-success-border bg-state-success-bg text-state-success ring-2 ring-emerald-500/15 hover:bg-state-success-bg"
                : "border-state-success-border bg-state-success-bg text-state-success hover:border-state-success-border hover:bg-state-success-bg",
            )}
            onClick={() => chooseRating("up")}
            aria-pressed={openRating === "up"}
            disabled={saving}
            title="Save positive feedback about this post"
          >
            <ThumbsUp className="h-3.5 w-3.5" />
            Good
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 rounded-full gap-1.5 border transition-colors",
              openRating === "down"
                ? "border-state-danger-border bg-state-danger-bg text-state-danger ring-2 ring-red-500/15 hover:bg-state-danger-bg"
                : "border-state-danger-border bg-state-danger-bg text-state-danger hover:border-state-danger-border hover:bg-state-danger-bg",
            )}
            onClick={() => chooseRating("down")}
            aria-pressed={openRating === "down"}
            disabled={saving}
            title="Save negative feedback about this post"
          >
            <ThumbsDown className="h-3.5 w-3.5" />
            Needs work
          </Button>
        </div>
      </div>

      {openRating && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {reasons.map((reason) => {
              const on = selected.includes(reason);
              return (
                <button
                  key={reason}
                  type="button"
                  disabled={saving}
                  onClick={() => toggleReason(reason)}
                  aria-pressed={on}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    on
                      ? "border-primary/40 bg-primary/[0.08] text-primary"
                      : "border-border bg-background/80 text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {reason}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {phraseSelected && openRating === "down" && (
        <div className="mt-3 flex flex-col gap-2 rounded-xl border border-border bg-background/65 p-2 sm:flex-row sm:items-center">
          <input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="Phrase Cowork should never say..."
            className="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/55"
            disabled={saving}
          />
        </div>
      )}

      {openRating && (
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder={
            openRating === "up"
              ? "What landed? Your take teaches Cowork what to repeat (optional)…"
              : "What felt off? Your take teaches Cowork what to avoid (optional)…"
          }
          className="mt-3 w-full resize-none rounded-xl border border-border bg-background/80 px-3 py-2 text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground/55 focus:ring-2 focus:ring-ring/25"
          disabled={saving}
        />
      )}

      {openRating && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {selected.length}/{FEEDBACK_REASON_LIMIT} selected
          </span>
          <Button
            type="button"
            size="sm"
            className="h-8"
            onClick={saveSelectedFeedback}
            disabled={saving || (selected.length === 0 && !note.trim())}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save feedback
          </Button>
        </div>
      )}

      {savedRating && !openRating && (
        <p className="mt-2 text-xs text-muted-foreground">
          Saved {savedRating === "up" ? "positive" : "negative"} feedback.
        </p>
      )}
    </section>
  );
}

function PostMediaSection({
  attachments,
  uploading,
  pendingMediaIds,
  onAdd,
  onOpenLibrary,
  onRemove,
}: {
  attachments: PostMediaAttachment[];
  uploading: boolean;
  pendingMediaIds: ReadonlySet<string>;
  onAdd: (files: FileList | File[]) => void;
  onOpenLibrary: () => void;
  onRemove: (id: string) => void;
}) {
  const fileInputId = "post-media-upload";
  const mediaHelp =
    attachments.length === 0
      ? "Drag, upload, or paste an image — or attach one video or PDF. Zernio media must publish within 7 days of upload."
      : mediaSummary(attachments);
  return (
    <div className="rounded-lg border border-border bg-card/70 p-3 shadow-soft">
      <div className="mb-3 flex items-start gap-2.5">
        <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight">Media</div>
          <p className="mt-0.5 max-w-[34ch] text-xs leading-snug text-muted-foreground">{mediaHelp}</p>
        </div>
        <input
          id={fileInputId}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/x-msvideo,video/webm,application/pdf"
          className="sr-only"
          onChange={(e) => {
            if (e.currentTarget.files) onAdd(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
      </div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-center gap-1.5"
          onClick={onOpenLibrary}
        >
          <Images className="h-3.5 w-3.5" />
          Library
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="w-full justify-center gap-1.5"
          disabled={uploading}
          onClick={() => document.getElementById(fileInputId)?.click()}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <UploadCloud className="h-3.5 w-3.5" />
          )}
          {uploading ? "Uploading…" : "Attach"}
        </Button>
      </div>
      {attachments.length > 0 && (
        <div className="space-y-1.5">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-xl border border-border bg-background/70 px-2.5 py-2 text-sm"
            >
              <span className="text-muted-foreground">{mediaIcon(attachment.type)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{attachment.name}</div>
                <div className="text-xs text-muted-foreground">
                  {mediaTypeLabel(attachment.type)} · {formatBytes(attachment.size)}
                  {pendingMediaIds.has(attachment.id) ? " · Uploading…" : ""}
                  {attachment.source === "library" ? " · Library" : ""}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type MediaLibraryAsset = {
  id: string;
  filename: string;
  name?: string;
  mimeType: string;
  size: number;
  type: PostMediaType;
  signedUrl: string | null;
  assetId?: string | null;
  storageBucket?: string | null;
  storagePath?: string | null;
  createdAt: string;
};

type MediaLibraryQuota = {
  usedBytes: number;
  limitBytes: number;
  remainingBytes: number;
};

function MediaLibraryDialog({
  open,
  onOpenChange,
  currentAttachments,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentAttachments: PostMediaAttachment[];
  onSelect: (assets: MediaLibraryAsset[]) => void;
}) {
  const [assets, setAssets] = useState<MediaLibraryAsset[]>([]);
  const [quota, setQuota] = useState<MediaLibraryQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewErrorIds, setPreviewErrorIds] = useState<string[]>([]);
  const fileInputId = "media-library-upload";
  const [selectionSeed, setSelectionSeed] = useState(false);

  if (open && !selectionSeed) {
    setSelectionSeed(true);
    setSelectedIds([]);
    setPreviewErrorIds([]);
  } else if (!open && selectionSeed) {
    setSelectionSeed(false);
  }

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        assets?: MediaLibraryAsset[];
        quota?: MediaLibraryQuota;
      }>("/api/media-assets");
      if (!data.ok) throw new Error(data.error || "Couldn't load media library.");
      setAssets(data.assets ?? []);
      setPreviewErrorIds([]);
      setQuota(data.quota ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      const t = window.setTimeout(() => void loadAssets(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open, loadAssets]);

  const selectedAssets = assets.filter((asset) => selectedIds.includes(asset.id));

  const toggle = (asset: MediaLibraryAsset) => {
    const nextIds = selectedIds.includes(asset.id)
      ? selectedIds.filter((id) => id !== asset.id)
      : [...selectedIds, asset.id];
    const nextAssets = assets.filter((candidate) => nextIds.includes(candidate.id));
    const setError = validatePostMediaSet([
      ...currentAttachments,
      ...nextAssets.map(mediaAssetAttachment),
    ]);
    if (setError) {
      toast.error(setError);
      return;
    }
    setSelectedIds(nextIds);
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files);
    if (selected.length === 0 || uploading) return;
    setUploading(true);
    try {
      for (const file of selected) {
        const form = new FormData();
        form.append("file", file, file.name);
        const data = await fetchJson<{
          ok: boolean;
          error?: string;
          asset?: MediaLibraryAsset;
          quota?: MediaLibraryQuota;
        }>("/api/media-assets", {
          method: "POST",
          body: form,
        });
        if (!data.ok || !data.asset) throw new Error(data.error || "Couldn't upload media.");
        setAssets((current) => [data.asset!, ...current]);
        if (data.quota) setQuota(data.quota);
      }
      toast.success(selected.length === 1 ? "Uploaded to library" : "Uploaded to library");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const deleteAsset = async (asset: MediaLibraryAsset) => {
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/media-assets/${asset.id}`,
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error || "Couldn't delete media.");
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setSelectedIds((current) => current.filter((id) => id !== asset.id));
      void loadAssets();
      toast.success("Media deleted");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const attach = () => {
    if (selectedAssets.length === 0) return;
    onSelect(selectedAssets);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[92vh] max-w-[min(1400px,96vw)] overflow-hidden rounded-[1.25rem] border-border bg-card p-0 shadow-soft-lg sm:max-w-[min(1400px,96vw)]"
      >
        <div className="flex items-start justify-between gap-8 border-b border-border bg-card/90 px-6 py-5">
          <div>
            <DialogTitle className="text-2xl font-semibold tracking-tight">Media library</DialogTitle>
            <DialogDescription className="mt-2 max-w-[42ch] text-sm leading-relaxed text-muted-foreground">
              Upload once, then reuse images, videos, or PDFs on any post.
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-3 pr-1">
            <input
              id={fileInputId}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,application/pdf"
              className="sr-only"
              onChange={(e) => {
                if (e.currentTarget.files) void uploadFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={uploading}
              onClick={() => document.getElementById(fileInputId)?.click()}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
              Upload
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => onOpenChange(false)}
              aria-label="Close media library"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-b border-border/50 bg-background/55 px-6 py-3 text-sm text-muted-foreground">
          <div className="inline-flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5" />
            {quota
              ? `${formatBytes(quota.usedBytes)} of ${formatBytes(quota.limitBytes)} used`
              : "Storage usage"}
          </div>
          <div>Images can be combined. Videos and PDFs attach one at a time.</div>
        </div>

        <div className="max-h-[68vh] min-h-[420px] overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="grid min-h-[420px] place-items-center text-sm text-muted-foreground">
              <Loader2 className="mb-2 h-5 w-5 animate-spin" />
              Loading media...
            </div>
          ) : assets.length === 0 ? (
            <div className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-border/80 bg-card/60 text-center">
              <div>
                <Images className="mx-auto mb-3 h-8 w-8 text-muted-foreground/60" />
                <p className="text-sm font-medium">No media yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Upload images, videos, or PDFs to reuse in posts.</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {assets.map((asset) => {
                const selected = selectedIds.includes(asset.id);
                const previewBroken = previewErrorIds.includes(asset.id);
                const showImage = asset.type === "image" && !!asset.signedUrl && !previewBroken;
                const previewSrc = showImage ? asset.signedUrl : undefined;
                return (
                  <div
                    key={asset.id}
                    className={cn(
                      "group overflow-hidden rounded-2xl border bg-card shadow-soft transition-colors",
                      selected ? "border-primary/60 ring-2 ring-primary/15" : "border-border hover:border-primary/30",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => toggle(asset)}
                      className="block w-full text-left"
                    >
                      <div className="relative grid aspect-[16/10] place-items-center overflow-hidden bg-muted/45">
                        {previewSrc ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={previewSrc}
                            alt={asset.filename}
                            className="h-full w-full object-cover"
                            onError={() =>
                              setPreviewErrorIds((current) =>
                                current.includes(asset.id) ? current : [...current, asset.id],
                              )
                            }
                          />
                        ) : (
                          <div className="flex flex-col items-center gap-2 text-muted-foreground">
                            {mediaIcon(asset.type)}
                            <span className="text-xs">
                              {asset.type === "image" ? "Preview unavailable" : mediaTypeLabel(asset.type)}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="space-y-1.5 p-3">
                        <div className="truncate text-sm font-medium">{asset.filename}</div>
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{mediaTypeLabel(asset.type)}</span>
                          <span>{formatBytes(asset.size)}</span>
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center justify-between border-t border-border px-2 py-1.5">
                      <span className={cn("text-xs", selected ? "text-primary" : "text-muted-foreground")}>
                        {selected ? "Selected" : "Saved"}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => void deleteAsset(asset)}
                        aria-label={`Delete ${asset.filename}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border bg-card/90 px-6 py-4">
          <span className="text-sm text-muted-foreground">
            {selectedAssets.length} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={attach} disabled={selectedAssets.length === 0}>
              Add to post
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function mediaAssetAttachment(asset: MediaLibraryAsset): PostMediaAttachment {
  const uploadedAt = Number.isFinite(Date.parse(asset.createdAt))
    ? new Date(asset.createdAt).toISOString()
    : new Date().toISOString();
  return {
    id: `asset:${asset.id}`,
    source: "library",
    assetId: asset.assetId ?? asset.id,
    name: asset.name ?? asset.filename,
    mimeType: asset.mimeType,
    size: asset.size,
    type: asset.type,
    storageBucket: asset.storageBucket,
    storagePath: asset.storagePath,
    previewUrl: asset.signedUrl,
    uploadedAt,
  };
}

async function uploadMediaViaServer(file: File): Promise<{
  publicUrl: string;
  key: string | null;
}> {
  const form = new FormData();
  form.append("file", file, file.name);
  const data = await fetchJson<{
    ok: boolean;
    error?: string;
    publicUrl?: string;
    key?: string | null;
  }>("/api/zernio/media/upload", {
    method: "POST",
    body: form,
  });
  if (!data.ok || !data.publicUrl) {
    throw new Error(data.error || "Media upload failed. Try again.");
  }
  return { publicUrl: data.publicUrl, key: data.key ?? null };
}

async function requestMediaPresign(file: File, contentType: string): Promise<{
  uploadUrl: string;
  publicUrl: string;
  key: string | null;
}> {
  const data = await fetchJson<{
    ok: boolean;
    error?: string;
    uploadUrl?: string;
    publicUrl?: string;
    key?: string | null;
  }>("/api/zernio/media/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, contentType, size: file.size }),
  });
  if (!data.ok || !data.uploadUrl || !data.publicUrl) {
    throw new Error(data.error || "Couldn't prepare media upload.");
  }
  return { uploadUrl: data.uploadUrl, publicUrl: data.publicUrl, key: data.key ?? null };
}

async function uploadMediaDirectly(file: File, uploadUrl: string, contentType: string) {
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!response.ok) throw new Error(`Direct media upload failed (${response.status}).`);
}

function mediaIcon(type: PostMediaType) {
  if (type === "image") return <ImageIcon className="h-4 w-4" />;
  if (type === "video") return <Video className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

function mediaTypeLabel(type: PostMediaType): string {
  if (type === "image") return "Image";
  if (type === "video") return "Video";
  return "PDF";
}

function mediaSummary(attachments: PostMediaAttachment[]): string {
  const type = attachments[0]?.type;
  if (type === "image") return `${attachments.length}/${MAX_LINKEDIN_IMAGES} images attached`;
  if (type === "video") return "1 video attached";
  return "1 PDF attached";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function mediaExpiryMs(attachments: PostMediaAttachment[]): number {
  const uploaded = attachments
    .map((a) => new Date(a.uploadedAt).getTime())
    .filter((t) => Number.isFinite(t));
  if (uploaded.length === 0) return Infinity;
  return Math.min(...uploaded) + 7 * 24 * 60 * 60 * 1000;
}

// One Notion-style property row: icon + label on the left, control on the right.
function PropRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex w-28 shrink-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </div>
      <div className={cn("min-w-0 flex-1")}>{children}</div>
    </div>
  );
}

// ISO instant → the value a <input type="datetime-local"> expects (local wall
// time, no zone, minute precision). Returns "" for null/invalid.
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  // Shift by the local offset so toISOString's UTC slice reads as local time.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

// A datetime-local value (local wall time) → an ISO instant (UTC).
function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v); // parsed as LOCAL time
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// The "Publish to LinkedIn" control in the draft editor. Turns the draft into a
// real, timed auto-publish via the Zernio cron (POST /api/drafts/[id]/schedule),
// or cancels one. Gates on the workspace's LinkedIn connection: with none, it
// shows a "Connect in Settings" prompt instead of the picker (belt to the
// endpoint's own 409). Optimistic — updates the draft via onMeta.
type ScheduleInput = {
  scheduledAt: string;
  planToPostOn: string;
  firstComment: string | null;
};

type ScheduleResponse = {
  scheduledAt?: string;
  planToPostOn?: string;
  firstComment?: string | null;
};

async function scheduleDraft(id: string, input: ScheduleInput): Promise<ScheduleResponse> {
  const data = await fetchJson<{ ok: boolean; error?: string } & ScheduleResponse>(
    `/api/drafts/${id}/schedule`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!data.ok) throw new Error(data.error || "Couldn't schedule.");
  return data;
}

function ScheduleRow({
  draft,
  onMeta,
  onCreateAndSchedule,
  previewBody,
  previewMedia,
  mediaUploading = false,
}: {
  draft: Draft | null;
  onMeta: (id: string, patch: Partial<Draft>) => void;
  onCreateAndSchedule?: (input: ScheduleInput) => Promise<void>;
  previewBody?: string;
  previewMedia?: PostMediaAttachment[];
  mediaUploading?: boolean;
}) {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [when, setWhen] = useState(isoToLocalInput(draft?.scheduledAt));
  const [firstComment, setFirstComment] = useState(draft?.firstComment ?? "");
  const [busy, setBusy] = useState(false);

  // Re-seed the picker when the draft's COMMITTED schedule changes underneath
  // us (the cron published it, another session scheduled it, or the parent
  // applied an optimistic onMeta patch). Without this the row seeded once at
  // mount and then showed a stale time forever — and re-scheduling from it
  // would overwrite the real schedule. We use the "adjust state during render,
  // keyed on the committed value" pattern (same as titleSeed / the editor's
  // seedKey), and only overwrite a local field that still matches the PREVIOUS
  // committed value — so an in-progress unsaved pick the user is typing is
  // never clobbered. React runs the render again with the new state; no effect.
  const committedWhen = isoToLocalInput(draft?.scheduledAt);
  const committedComment = draft?.firstComment ?? "";
  const [seededWhen, setSeededWhen] = useState(committedWhen);
  const [seededComment, setSeededComment] = useState(committedComment);
  if (seededWhen !== committedWhen) {
    // Only follow the new committed value if the user hasn't edited the field
    // (it still equals what we last seeded). Otherwise keep their pick.
    if (when === seededWhen) setWhen(committedWhen);
    setSeededWhen(committedWhen);
  }
  if (seededComment !== committedComment) {
    if (firstComment === seededComment) setFirstComment(committedComment);
    setSeededComment(committedComment);
  }

  // Is a real schedule already committed? (scheduled/publishing) vs. planning.
  const scheduled =
    draft?.scheduleStatus === "scheduled" || draft?.scheduleStatus === "publishing";
  const failed = draft?.scheduleStatus === "failed";
  // Successfully published — the cron flipped schedule_status='published' and
  // stamped published_at. The card should show WHEN, not the picker/connect prompt.
  const published = draft?.scheduleStatus === "published";
  const publishBody = draftEgressBody(draft?.body ?? previewBody ?? "", draft?.meta);
  const overLimit = publishBody.length > LINKEDIN_MAX_CHARS;
  const attachments = draft?.mediaAttachments ?? previewMedia ?? [];
  const hasMedia = attachments.length > 0;
  const mediaExpiry = mediaExpiryMs(attachments);
  const mediaTooLate =
    hasMedia && when
      ? (new Date(when).getTime() || 0) > mediaExpiry
      : false;

  // Load connection status once (the endpoint enforces it too).
  const loadConn = useCallback(async () => {
    try {
      const data = await fetchJson<{ ok: boolean; connection: { connected: boolean } | null }>(
        "/api/integrations/linkedin",
        { cache: "no-store" },
      );
      setConnected(!!data.connection?.connected);
    } catch {
      setConnected(false);
    }
  }, []);
  useEffect(() => {
    // Mount fetch of an external system's state (the API) — the sanctioned use.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadConn();
  }, [loadConn]);

  const schedule = async () => {
    const iso = localInputToIso(when);
    const planToPostOn = localDateFromDatetimeInput(when);
    if (!iso || !planToPostOn) {
      toast.error("Pick a date and time.");
      return;
    }
    setBusy(true);
    try {
      const input = { scheduledAt: iso, planToPostOn, firstComment: firstComment.trim() || null };
      if (!draft) {
        await onCreateAndSchedule?.(input);
        return;
      }
      const data = await scheduleDraft(draft.id, input);
      onMeta(draft.id, {
        scheduledAt: data.scheduledAt ?? iso,
        scheduleStatus: "scheduled",
        planToPostOn: data.planToPostOn ?? planToPostOn,
        firstComment: data.firstComment ?? null,
        publishError: null,
      });
      toast.success("Scheduled to publish on LinkedIn.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/drafts/${draft.id}/schedule`,
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error || "Couldn't unschedule.");
      onMeta(draft.id, { scheduledAt: null, scheduleStatus: null, firstComment: null });
      toast.success("Unscheduled.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Already published — the cron confirmed LinkedIn accepted the post. Show WHEN
  // (published_at, or a fallback to scheduled_at if the stamp is missing). This
  // beats every other branch so a published card doesn't ask to connect/pick a
  // time again.
  if (published) {
    const when = draft.publishedAt ?? draft.scheduledAt;
    return (
      <div className="flex items-center gap-2 rounded-lg border border-state-success-border bg-state-success-bg px-3 py-2.5 text-sm">
        <Check className="h-4 w-4 shrink-0 text-state-success" />
        <span className="flex-1 text-state-success">
          Published{" "}
          <span className="font-medium">
            {when
              ? new Date(when).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "on LinkedIn"}
          </span>
        </span>
      </div>
    );
  }

  // Not connected → a prompt to connect, in place of the picker.
  if (connected === false) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <Send className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-muted-foreground">
          Connect your LinkedIn account to schedule posts.
        </span>
        <Button size="sm" variant="outline" onClick={() => router.push("/dashboard/settings")}>
          Connect
        </Button>
      </div>
    );
  }

  // Already scheduled → show when + a Cancel action.
  if (scheduled) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.04] px-3 py-2.5 text-sm">
        <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1">
          {draft?.scheduleStatus === "publishing" ? "Publishing…" : "Scheduled for"}{" "}
          <span className="font-medium">
            {draft.scheduledAt
              ? new Date(draft.scheduledAt).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : ""}
          </span>
        </span>
        {draft?.scheduleStatus === "scheduled" && (
          <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            Cancel
          </Button>
        )}
      </div>
    );
  }

  // Not scheduled (or failed → let them reschedule) → the picker + first comment.
  return (
    <div className="rounded-lg border border-border bg-card/70 p-3 shadow-soft">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Send className="h-4 w-4 text-primary" />
        Schedule on LinkedIn
      </div>
      <p className="mb-2 text-xs leading-snug text-muted-foreground">
        This creates the real LinkedIn publishing schedule. The planning date above
        is only for organizing your calendar.
        {hasMedia ? " Media posts must publish within 7 days of upload." : ""}
      </p>
      {failed && draft.publishError && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
          {draft.publishError}
        </div>
      )}
      {mediaTooLate && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
          Pick a time within 7 days, or attach the media closer to publish time.
        </div>
      )}
      <div className="flex flex-col gap-2">
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="h-9 rounded-xl border border-border bg-background/80 px-2 text-sm outline-none focus:border-primary"
          aria-label="Publish date and time"
          title="Choose the exact time this post should auto-publish on LinkedIn."
        />
        <input
          type="text"
          value={firstComment}
          onChange={(e) => setFirstComment(e.target.value)}
          placeholder="First comment (optional), put links here to protect reach"
          className="h-9 rounded-xl border border-border bg-background/80 px-2 text-sm outline-none focus:border-primary"
          aria-label="First comment"
          title="Optional: add a first comment after publishing. Useful for links or extra context."
        />
        <div className="flex items-center gap-2">
          <span className={cn("text-xs", overLimit ? "text-destructive" : "text-muted-foreground")}>
            {publishBody.length}/{LINKEDIN_MAX_CHARS}
            {overLimit && ` — trim ${publishBody.length - LINKEDIN_MAX_CHARS}`}
          </span>
          <Button
            size="sm"
            className="ml-auto gap-1.5"
            onClick={schedule}
            disabled={busy || mediaUploading || overLimit || mediaTooLate || !when}
            title="Schedule this post to publish on LinkedIn at the selected time."
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" />}
            {failed ? "Reschedule" : draft ? "Schedule on LinkedIn" : "Create & schedule on LinkedIn"}
          </Button>
        </div>
      </div>
    </div>
  );
}
