import Link from "next/link";
import Image from "next/image";
import { auth } from "@clerk/nextjs/server";
import { SiteHeaderShell } from "./site-header-shell";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}

async function SiteHeader() {
  // Resolve `signedIn` server-side so the header doesn't flash a wrong CTA on
  // hydration, then hand off to the client shell that owns the scroll-state
  // animation (sticky bg/blur/shadow once you scroll past the hero).
  const { userId } = await auth();
  return <SiteHeaderShell signedIn={!!userId} />;
}

function SiteFooter() {
  // Ft2 inline single-line footer: wordmark, links, and copyright share one
  // row (wrapping on small screens) — no link columns, no brand blurb.
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex w-full max-w-[1180px] flex-wrap items-center justify-between gap-x-8 gap-y-4 px-4 py-7 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="SwipeIn home">
          <Image src="/swipeInIcon.png" alt="" width={24} height={24} className="size-6 rounded-[6px]" />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">SwipeIn</span>
        </Link>
        <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] font-medium text-muted-foreground">
          <Link href="/#features" className="whitespace-nowrap transition-colors hover:text-foreground">
            Features
          </Link>
          <Link href="/#pricing" className="whitespace-nowrap transition-colors hover:text-foreground">
            Pricing
          </Link>
          <Link href="/#faq" className="whitespace-nowrap transition-colors hover:text-foreground">
            FAQ
          </Link>
          <Link href="/privacy" className="whitespace-nowrap transition-colors hover:text-foreground">
            Privacy
          </Link>
          <Link href="/terms" className="whitespace-nowrap transition-colors hover:text-foreground">
            Terms
          </Link>
        </nav>
        <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} SwipeIn. All rights reserved.</p>
      </div>
    </footer>
  );
}
