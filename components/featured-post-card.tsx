import Link from "next/link";
import Image from "next/image";
import { Card } from "@/components/ui/card";
import { Flame, MessageCircle, ThumbsUp, Repeat, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/app-surface";
import { creatorAvatarFallback } from "@/lib/post-card-helpers";
import { AvatarImg } from "@/components/avatar-img";

type FeaturedPost = {
  id: string;
  text: string | null;
  post_url: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  media_type: string;
  media_urls: string[];
  accounts: { name: string; niche: string | null; profile_pic_url?: string | null } | null;
};

// Warm palette to match the cream/coral design system.
const AVATAR_TINTS = [
  "bg-state-warning-bg text-state-warning",
  "bg-state-warning-bg text-state-warning",
  "bg-state-danger-bg text-state-danger",
  "bg-stone-200 text-stone-700",
  "bg-state-warning-bg text-state-warning",
  "bg-state-danger-bg text-state-danger",
  "bg-state-success-bg text-state-success",
  "bg-state-brand-bg text-state-brand",
];
function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return n.toLocaleString();
}

export function FeaturedPostCard({ post, rank, priority }: { post: FeaturedPost; rank: number; priority?: boolean }) {
  const name = post.accounts?.name ?? "Unknown";
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const hook = (post.text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  const img = post.media_type === "image" ? post.media_urls[0] : null;
  const avatarUrl = post.accounts?.profile_pic_url ?? null;

  return (
    <Card className="w-72 shrink-0 overflow-hidden rounded-xl border-border/70 bg-card/90 flex flex-col transition-[border-color,box-shadow] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none hover:border-primary/18 hover:shadow-soft-lg">
      <div className="relative">
        {img ? (
          <div className="relative h-32 w-full">
            <Image
              src={img}
              alt=""
              fill
              sizes="288px"
              className="object-cover"
              referrerPolicy="no-referrer"
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              quality={70}
            />
          </div>
        ) : (
          <div className="h-32 w-full bg-[radial-gradient(circle_at_50%_20%,rgb(214_82_48_/_0.12),transparent_18rem)] grid place-items-center px-4">
            <span className="text-xs text-muted-foreground line-clamp-3 text-center">{hook}</span>
          </div>
        )}
        <StatusPill
          tone="primary"
          className="absolute top-2 left-2 border-primary/25 bg-card/90 text-primary shadow-soft"
        >
          <Flame className="h-3 w-3" /> #{rank + 1}
        </StatusPill>
        {post.post_url && (
          <a
            href={post.post_url}
            target="_blank"
            className="absolute top-1 right-1 grid size-10 place-items-center rounded-full bg-card/90 text-muted-foreground shadow-soft transition-[color,background-color,scale] hover:bg-background hover:text-primary active:scale-[0.96] motion-reduce:transition-none"
            title="View on LinkedIn"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="px-4 py-3 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {/* AvatarImg is a client component, and it has to be: this card is
              rendered from the /dashboard/swipe SERVER component, where an
              onError prop cannot cross the boundary — passing one threw
              "Event handlers cannot be passed to Client Component props" on
              every render of the page. It also replaces the old hide-and-
              unhide-the-sibling DOM mutation with React state, so the fallback
              chain (LinkedIn photo -> DiceBear -> initials) is the same but
              expressed as rendering rather than imperative class toggling. */}
          <AvatarImg
            src={avatarUrl}
            fallbackSrc={creatorAvatarFallback(name)}
            alt={avatarUrl ? name : ""}
            className="h-7 w-7 rounded-full object-cover shrink-0 bg-muted"
            fallback={
              <div
                className={cn(
                  "h-7 w-7 rounded-full grid place-items-center text-[10px] font-semibold shrink-0",
                  tintFor(name),
                )}
              >
                {initials || "?"}
              </div>
            }
          />
          <div className="truncate text-xs font-semibold" title={name}>{name}</div>
        </div>
        {img && hook && (
          <div className="text-xs text-foreground/80 line-clamp-2 leading-snug">{hook}</div>
        )}
        <div className="mt-auto flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 tabular-nums font-medium text-foreground/80">
            <ThumbsUp className="h-3 w-3" /> {compact(post.reactions)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 tabular-nums">
            <MessageCircle className="h-3 w-3" /> {compact(post.comments)}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 tabular-nums">
            <Repeat className="h-3 w-3" /> {compact(post.reposts)}
          </span>
          <Link
            href={`#post-${post.id}`}
            className="ml-auto text-primary hover:text-primary/80 font-medium"
          >
            Jump
          </Link>
        </div>
      </div>
    </Card>
  );
}
