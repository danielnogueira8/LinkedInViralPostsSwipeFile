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
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto w-full max-w-[1060px] px-6 py-12 lg:px-0">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 space-y-3">
            <Link href="/" className="flex items-center">
              <Image
                src="/swipeIntypography.png"
                alt="SwipeIn"
                width={320}
                height={80}
                className="h-8 w-auto"
              />
            </Link>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground font-sans">
              The LinkedIn viral posts swipe file. Daily-scraped viral
              LinkedIn posts, now an agent inside Claude. For anyone shipping
              on LinkedIn.
            </p>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-black font-sans">Product</div>
            <ul className="space-y-2 text-sm text-muted-foreground font-sans">
              <li>
                <Link href="/#features" className="hover:text-black">
                  Features
                </Link>
              </li>
              <li>
                <Link href="/#pricing" className="hover:text-black">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/#faq" className="hover:text-black">
                  FAQ
                </Link>
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-black font-sans">Legal</div>
            <ul className="space-y-2 text-sm text-muted-foreground font-sans">
              <li>
                <Link href="/privacy" className="hover:text-black">
                  Privacy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="hover:text-black">
                  Terms
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground md:flex-row md:items-center font-sans">
          <div>© {new Date().getFullYear()} SwipeIn. All rights reserved.</div>
        </div>
      </div>
    </footer>
  );
}
