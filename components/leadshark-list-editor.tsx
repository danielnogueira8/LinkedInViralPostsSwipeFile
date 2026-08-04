"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// A small string-list editor (keywords, DM variations, reply templates).
export function ListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
  multiline,
  max,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  multiline?: boolean;
  max?: number;
}) {
  const set = (i: number, v: string) => onChange(values.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => onChange(values.filter((_, j) => j !== i));
  const atMax = max != null && values.length >= max;
  return (
    <div className="space-y-2">
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-2">
          {multiline ? (
            <Textarea
              value={v}
              onChange={(e) => set(i, e.target.value)}
              placeholder={placeholder}
              className="min-h-16 flex-1"
            />
          ) : (
            <Input
              value={v}
              onChange={(e) => set(i, e.target.value)}
              placeholder={placeholder}
              className="flex-1"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => remove(i)}
            aria-label="Remove"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {!atMax ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => onChange([...values, ""])}
        >
          <Plus className="h-3.5 w-3.5" /> {addLabel}
        </Button>
      ) : null}
    </div>
  );
}
