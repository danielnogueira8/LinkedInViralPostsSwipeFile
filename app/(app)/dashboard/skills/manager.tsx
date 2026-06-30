"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Plus, Trash2, Pencil, Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import {
  normalizeSkillName,
  SKILL_BODY_MAX,
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
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {skills.length} skill{skills.length === 1 ? "" : "s"}
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New skill
        </Button>
      </div>

      {skills.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No custom skills yet. Click <strong>New skill</strong> to create one —
            for example, a skill named <code>cta</code> whose body is your standard
            call-to-action so you can apply it with <code>/cta</code>.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {skills.map((s) => (
            <Card key={s.id} className="flex flex-col">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Zap className="h-4 w-4 text-amber-500 shrink-0" aria-hidden />
                  <code className="text-sm">/{s.name}</code>
                </CardTitle>
                {s.description && (
                  <p className="text-xs text-muted-foreground break-words">
                    {s.description}
                  </p>
                )}
              </CardHeader>
              <CardContent className="flex-1 flex flex-col gap-3">
                <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap break-words">
                  {s.body}
                </p>
                <div className="mt-auto flex items-center gap-2">
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
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
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
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
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
  const slug = normalizeSkillName(name);

  const save = async () => {
    if (busy) return;
    if (!slug) return toast.error("Give the skill a name (letters or numbers).");
    if (!body.trim()) return toast.error("The skill needs a body.");
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
      <div className="space-y-4">
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
            className="resize-none overflow-y-auto break-words [field-sizing:fixed] max-h-[8rem]"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="skill-body">Instructions</Label>
          <Textarea
            id="skill-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="End every post with: 'Want the full breakdown? Comment GUIDE and I'll send it.'"
            rows={6}
            maxLength={SKILL_BODY_MAX}
            className="resize-none overflow-y-auto break-words [field-sizing:fixed] max-h-[16rem]"
          />
          <p className="text-xs text-muted-foreground text-right">
            {body.length}/{SKILL_BODY_MAX}
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {skill ? "Save changes" : "Create skill"}
        </Button>
      </DialogFooter>
    </>
  );
}
