"use client";

import { useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, StatusPill, Toolbar } from "@/components/app-surface";
import { Plus, Trash2, Pencil, Loader2, Zap, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import {
  checkSkillBodyAbuse,
  normalizeSkillName,
  isSkillImportFilename,
  parseSkillImportBytes,
  SKILL_BODY_MAX,
  SKILL_BODY_SOFT_WARN,
  SKILL_DESC_MAX,
  type CustomSkill,
} from "@/lib/custom-skills";

export function SkillsManager({ initial }: { initial: CustomSkill[] }) {
  const [skills, setSkills] = useState(initial);
  const [editing, setEditing] = useState<CustomSkill | null>(null);
  const [creating, setCreating] = useState(false);
  // The skill pending a delete-confirm (controlled ConfirmDialog).
  const [confirmDelete, setConfirmDelete] = useState<CustomSkill | null>(null);

  const remove = async (id: string) => {
    // Reconcile-don't-restore rollback (lib/optimistic.ts).
    const removed = byId(skills, id);
    setSkills((s) => removeById(s, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/skills/${id}`,
        { method: "DELETE" },
      );
      if (!data?.ok) throw new Error(data?.error || "Failed to delete");
      toast.success("Skill deleted");
    } catch (e) {
      setSkills((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Skill library</div>
          <div className="text-xs text-muted-foreground">
            {skills.length} custom skill{skills.length === 1 ? "" : "s"} available in Cowork
          </div>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New skill
        </Button>
      </Toolbar>

      {skills.length === 0 ? (
        <EmptyState
          icon={<Zap className="h-6 w-6" />}
          title="No custom skills yet"
          description={
            <>
              Create one when you want Cowork to reuse the same guidance across
              many drafts. Apply it with <code>/name</code> or the skills picker.
            </>
          }
          action={
            <div className="space-y-4">
              <div className="grid gap-2 text-left sm:grid-cols-3">
                {[
                  ["cta", "Your standard call-to-action and offer language."],
                  ["founder", "Your founder-story angle, boundaries, and examples."],
                  ["launch", "Rules for launch posts: structure, proof, and CTA."],
                ].map(([name, body]) => (
                  <div key={name} className="rounded-[0.85rem] border border-border/60 bg-background/80 px-3 py-2.5">
                    <code className="text-xs text-foreground">/{name}</code>
                    <p className="mt-1 text-xs leading-snug">{body}</p>
                  </div>
                ))}
              </div>
              <Button onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New skill
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {skills.map((s) => (
            <Card key={s.id} className="flex flex-col overflow-hidden border-border/70 bg-card/88 shadow-soft transition-all hover:border-primary/18 hover:shadow-soft-lg">
              <CardContent className="flex-1 flex flex-col gap-4 p-4">
                <div className="flex items-start gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-amber-500/15 bg-amber-500/10 text-amber-600">
                    <Zap className="h-4 w-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-semibold text-foreground">
                        {s.name}
                      </h2>
                      <StatusPill tone="warning" className="h-5 px-2 text-[10px]">
                        /{s.name}
                      </StatusPill>
                    </div>
                    {s.description && (
                      <p className="line-clamp-2 text-xs leading-snug text-muted-foreground break-words">
                        {s.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="rounded-[0.9rem] border border-border/55 bg-background/55 px-3 py-2.5">
                  <p className="text-sm text-muted-foreground line-clamp-5 whitespace-pre-wrap break-words">
                    {s.body}
                  </p>
                </div>
                <div className="mt-auto flex items-center gap-2 border-t border-border/50 pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => setEditing(s)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-destructive"
                    onClick={() => setConfirmDelete(s)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-x-hidden overflow-y-auto">
          <SkillForm
            onSaved={(s) => {
              setSkills((cur) => [s, ...cur]);
              setCreating(false);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-x-hidden overflow-y-auto">
          {editing && (
            <SkillForm
              skill={editing}
              onSaved={(s) => {
                setSkills((cur) => cur.map((x) => (x.id === s.id ? s : x)));
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={confirmDelete ? `Delete /${confirmDelete.name}?` : "Delete skill?"}
        description="This removes the skill for the whole workspace."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function SkillForm({
  skill,
  onSaved,
}: {
  skill?: CustomSkill;
  onSaved: (s: CustomSkill) => void;
}) {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const slug = normalizeSkillName(name);

  const importSkillFile = async (file: File) => {
    if (!isSkillImportFilename(file.name)) {
      toast.error("Upload a .md, .skill, or .skills file.");
      return;
    }
    try {
      const imported = parseSkillImportBytes(file.name, new Uint8Array(await file.arrayBuffer()));
      setBody(imported.body);
      if (!name.trim()) {
        if (imported.name) setName(imported.name);
      }
      toast.success("Skill imported");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't read that skill file.");
    }
  };

  const save = async () => {
    if (busy) return;
    if (!slug) return toast.error("Give the skill a name (letters or numbers).");
    if (!body.trim()) return toast.error("The skill needs a body.");
    if (body.length > SKILL_BODY_MAX) {
      return toast.error(
        `Skill body is ${body.length.toLocaleString()} chars — ${SKILL_BODY_MAX.toLocaleString()} is the limit. Trim it and try again.`,
      );
    }
    // Preflight the same abuse check the server runs so the user gets a
    // friendly, specific error instantly instead of a round-trip 400.
    const abuse = checkSkillBodyAbuse(body);
    if (abuse) {
      return toast.error(
        `Can't save — the body looks like an ${abuse}. Skills are writing guidance (voice, structure, examples), not agent-override directives.`,
      );
    }
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; skill?: CustomSkill }>(
        skill ? `/api/skills/${skill.id}` : "/api/skills",
        {
          method: skill ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, description: description || null, body }),
        },
      );
      if (!data?.ok || !data.skill) throw new Error(data?.error || "Failed to save");
      toast.success(skill ? "Skill updated" : `/${data.skill.name} created`);
      onSaved(data.skill);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{skill ? "Edit skill" : "New skill"}</DialogTitle>
      </DialogHeader>
      <div className="min-w-0 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="skill-name">Name</Label>
          {/* Single line. The shadcn Input is already 1 line — we just prevent
              the rendered text from sneaking past the box on a long word. */}
          <Input
            id="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="cta"
            maxLength={80}
            className="truncate"
          />
          {slug && (
            <p className="text-xs text-muted-foreground break-all">
              Invoke with <code>/{slug}</code>
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-desc">Description (optional)</Label>
          {/* Cap visible height at ~5 lines, then scroll. The base Textarea
              uses `field-sizing-content` which grows with content (that was
              blowing the dialog past the viewport); override with
              `[field-sizing:fixed]` so rows= actually wins, and force long
              unbroken strings to wrap with `break-words`. */}
          <Textarea
            id="skill-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="My standard call-to-action"
            maxLength={SKILL_DESC_MAX}
            rows={2}
            className="min-w-0 max-w-full resize-none overflow-x-hidden overflow-y-auto break-words [field-sizing:fixed] [overflow-wrap:anywhere] max-h-[8rem]"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="skill-body">Instructions</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.skill,.skills,text/markdown,text/plain"
              className="sr-only"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) void importSkillFile(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload skill
            </Button>
          </div>
          <Textarea
            id="skill-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="End every post with: 'Want the full breakdown? Comment GUIDE and I'll send it.'"
            rows={10}
            wrap="soft"
            // overflow-y:scroll (not auto) keeps the scrollbar always visible —
            // a long body fills past the cap, and an auto-hidden bar (macOS
            // default) hid that there was MORE content above the visible
            // window, so users thought their text was truncated. The dialog
            // itself caps at calc(100vh-2rem) so we can give the textarea
            // generous height (28rem ≈ 18 visible lines) without overflowing.
            // overflow-wrap:anywhere avoids a horizontal scrollbar when a pasted
            // skill contains very long paths, URLs, or malformed binary text.
            className="min-w-0 max-w-full resize-none overflow-x-hidden overflow-y-scroll whitespace-pre-wrap break-words [field-sizing:fixed] [overflow-wrap:anywhere] max-h-[28rem]"
          />
          <div className="flex items-start justify-between gap-3">
            {/* At the soft warn a nudge — save still allowed. Past SKILL_BODY_MAX
                the input is rejected and Save is disabled. */}
            {body.length > SKILL_BODY_MAX ? (
              <p className="text-xs text-destructive leading-snug">
                Skill body is over the {SKILL_BODY_MAX.toLocaleString()}-char
                limit — trim it to save.
              </p>
            ) : body.length > SKILL_BODY_SOFT_WARN ? (
              <p className="text-xs text-amber-600 leading-snug">
                Long skills can dilute the agent&apos;s focus — a tighter skill
                usually performs better.
              </p>
            ) : (
              <span />
            )}
            <p
              className={cn(
                "text-xs text-right shrink-0 tabular-nums",
                body.length > SKILL_BODY_MAX
                  ? "text-destructive"
                  : body.length > SKILL_BODY_SOFT_WARN
                    ? "text-amber-600"
                    : "text-muted-foreground",
              )}
            >
              {body.length.toLocaleString()} / {SKILL_BODY_MAX.toLocaleString()} chars
            </p>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy || body.length > SKILL_BODY_MAX}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {skill ? "Save changes" : "Create skill"}
        </Button>
      </DialogFooter>
    </>
  );
}
