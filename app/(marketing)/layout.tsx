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
    <div className="flex min-h-screen flex-col bg-[#F7F5F3]">
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
    <footer className="border-t border-[rgba(55,50,47,0.12)] bg-[#F7F5F3]">
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
            <p className="max-w-sm text-sm leading-6 text-[#605A57] font-sans">
              The LinkedIn viral posts swipe file — daily-scraped viral
              LinkedIn posts, now an agent inside Claude. For anyone shipping
              on LinkedIn.
            </p>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-[#37322F] font-sans">Product</div>
            <ul className="space-y-2 text-sm text-[#605A57] font-sans">
              <li>
                <Link href="/#features" className="hover:text-[#37322F]">
                  Features
                </Link>
              </li>
              <li>
                <Link href="/#pricing" className="hover:text-[#37322F]">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/#faq" className="hover:text-[#37322F]">
                  FAQ
                </Link>
              </li>
            </ul>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium text-[#37322F] font-sans">Legal</div>
            <ul className="space-y-2 text-sm text-[#605A57] font-sans">
              <li>
                <Link href="/privacy" className="hover:text-[#37322F]">
                  Privacy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="hover:text-[#37322F]">
                  Terms
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-[rgba(55,50,47,0.12)] pt-6 text-xs text-[#847971] md:flex-row md:items-center font-sans">
          <div>© {new Date().getFullYear()} SwipeIn. All rights reserved.</div>
          <div className="font-mono">v0.1</div>
        </div>
      </div>
    </footer>
  );
}
