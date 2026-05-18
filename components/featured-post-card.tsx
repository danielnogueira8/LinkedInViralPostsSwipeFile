import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Flame, MessageCircle, ThumbsUp, Repeat, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

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

const AVATAR_TINTS = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-violet-100 text-violet-700",
  "bg-rose-100 text-rose-700",
  "bg-sky-100 text-sky-700",
  "bg-teal-100 text-teal-700",
  "bg-fuchsia-100 text-fuchsia-700",
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

export function FeaturedPostCard({ post, rank }: { post: FeaturedPost; rank: number }) {
  const name = post.accounts?.name ?? "Unknown";
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const hook = (post.text ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  const img = post.media_type === "image" ? post.media_urls[0] : null;
  const avatarUrl = post.accounts?.profile_pic_url ?? null;

  return (
    <Card className="w-72 shrink-0 overflow-hidden flex flex-col transition-shadow hover:shadow-[0_2px_4px_0_rgba(15,23,42,0.06),0_8px_24px_-4px_rgba(15,23,42,0.08)]">
      <div className="relative">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt="" className="h-32 w-full object-cover" />
        ) : (
          <div className="h-32 w-full bg-gradient-to-br from-primary/10 via-accent to-orange-500/10 grid place-items-center px-4">
            <span className="text-xs text-muted-foreground line-clamp-3 text-center">{hook}</span>
          </div>
        )}
        <div className="absolute top-2 left-2 inline-flex items-center gap-1 text-[10px] font-semibold rounded-full bg-orange-500 text-white px-2 py-0.5 shadow-sm">
          <Flame className="h-3 w-3" /> #{rank + 1}
        </div>
        {post.post_url && (
          <a
            href={post.post_url}
            target="_blank"
            className="absolute top-2 right-2 grid place-items-center h-6 w-6 rounded-md bg-background/80 text-muted-foreground hover:text-primary hover:bg-background transition-colors"
            title="View on LinkedIn"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="px-4 py-3 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {avatarUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={avatarUrl}
              alt={name}
              className="h-7 w-7 rounded-full object-cover shrink-0 bg-muted"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className={cn("h-7 w-7 rounded-full grid place-items-center text-[10px] font-semibold shrink-0", tintFor(name))}>
              {initials || "?"}
            </div>
          )}
          <div className="text-xs font-semibold truncate">{name}</div>
        </div>
        {img && hook && (
          <div className="text-xs text-foreground/80 line-clamp-2 leading-snug">{hook}</div>
        )}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-auto pt-1">
          <span className="inline-flex items-center gap-1 tabular-nums font-medium text-foreground/80">
            <ThumbsUp className="h-3 w-3" /> {compact(post.reactions)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <MessageCircle className="h-3 w-3" /> {compact(post.comments)}
          </span>
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Repeat className="h-3 w-3" /> {compact(post.reposts)}
          </span>
          <Link
            href={`#post-${post.id}`}
            className="ml-auto text-primary hover:text-primary/80 font-medium"
          >
            jump →
          </Link>
        </div>
      </div>
    </Card>
  );
}
