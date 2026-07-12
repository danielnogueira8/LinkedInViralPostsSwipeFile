import Link from "next/link";
import { Search } from "lucide-react";

export const metadata = {
  title: "Page not found · SwipeIn",
  description: "The page you're looking for doesn't exist.",
};

// Root-level not-found page. Rendered for any unmatched route across the app
// (marketing + dashboard). Kept minimal + brand-consistent — a 404 lands
// mostly on typo'd share links and stale bookmarks, so the goal is to
// redirect the user somewhere useful in one click rather than explain what
// went wrong. Design language mirrors /terms + /privacy (accent gradient
// header, display font, muted body copy, quiet round-pill link CTAs).
export default function NotFound() {
  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[300px] bg-gradient-to-b from-accent/30 to-transparent"
      />
      <section className="mx-auto flex min-h-[70vh] max-w-2xl flex-col items-center justify-center px-6 py-20 text-center">
        <div
          aria-hidden
          className="grid h-14 w-14 place-items-center rounded-2xl border border-border bg-card text-muted-foreground shadow-soft"
        >
          <Search className="h-6 w-6" />
        </div>
        <p className="mt-6 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Error 404
        </p>
        <h1 className="mt-3 font-display text-4xl leading-[1.1] tracking-tight md:text-5xl">
          This page doesn&apos;t exist.
        </h1>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-muted-foreground">
          The link you followed may be broken, or the page may have been moved.
          Head back and try again.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/dashboard"
            className="flex h-11 items-center justify-center rounded-[10px] bg-primary px-6 text-[15px] font-medium text-primary-foreground shadow-sm transition-[color,background-color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transform-none motion-reduce:transition-none hover:-translate-y-0.5 hover:bg-primary/90 active:translate-y-0"
          >
            Back to dashboard
          </Link>
          <Link
            href="/"
            className="flex h-11 items-center justify-center rounded-[10px] border border-border bg-card px-6 text-[15px] font-medium text-foreground shadow-sm transition-[color,background-color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transform-none motion-reduce:transition-none hover:-translate-y-0.5 hover:bg-muted active:translate-y-0"
          >
            Home
          </Link>
        </div>
      </section>
    </div>
  );
}
