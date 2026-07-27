"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
] as const;

export function SiteHeaderShell({ signedIn }: { signedIn: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  // Mobile disclosure menu — the desktop nav is hidden below `sm`, so without
  // this the marketing links (and Sign in) are unreachable on phones.
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrolled(window.scrollY > 16);
      });
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // N5 floating-pill nav: a detached rounded-full pill (hairline, blur, soft
  // shadow) inset from the viewport edges, replacing the full-width hairline
  // bar. The header stays sticky in flow so pages need no offset padding.
  return (
    <header className="sticky top-0 z-40 w-full px-3 pt-3 sm:px-5 sm:pt-4">
      <div
        className={cn(
          "mx-auto flex h-14 w-full max-w-[880px] items-center justify-between gap-4 rounded-full border border-border bg-background/80 pl-4 pr-2 backdrop-blur-md transition-[background-color,box-shadow] duration-200",
          scrolled || menuOpen ? "bg-background/92 shadow-soft-lg" : "shadow-soft",
        )}
      >
        <div className="flex items-center">
          <Link
            href="/"
            className="flex items-center gap-2.5"
            aria-label="SwipeIn home"
            onClick={() => setMenuOpen(false)}
          >
            <Image
              src="/swipeInIcon.png"
              alt="SwipeIn"
              width={30}
              height={30}
              priority
              className="size-[30px] shrink-0 rounded-[8px]"
            />
            <span className="text-[15px] font-semibold tracking-[-0.01em]">SwipeIn</span>
          </Link>
          <nav className="ml-8 hidden items-center gap-5 sm:flex" aria-label="Marketing navigation">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="whitespace-nowrap text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {signedIn ? (
            <>
              <Link
                href="/dashboard"
                className="inline-flex h-10 items-center rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] hover:bg-primary/88 active:scale-[0.96] motion-reduce:transition-none"
              >
                Dashboard
              </Link>
              <UserButton />
            </>
          ) : (
            <>
              <Link
                href="/sign-in"
                className="hidden whitespace-nowrap text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline"
              >
                Sign in
              </Link>
              <Link
                href="/sign-up"
                className="inline-flex h-10 items-center whitespace-nowrap rounded-full bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] hover:bg-primary/88 active:scale-[0.96] motion-reduce:transition-none"
              >
                Start for free
              </Link>
            </>
          )}
          <button
            type="button"
            className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:hidden"
            aria-expanded={menuOpen}
            aria-controls="marketing-mobile-menu"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? (
              <X className="h-5 w-5" aria-hidden />
            ) : (
              <Menu className="h-5 w-5" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {menuOpen && (
        <nav
          id="marketing-mobile-menu"
          aria-label="Marketing navigation"
          className="mx-auto mt-2 w-full max-w-[880px] rounded-[16px] border border-border bg-background/95 px-3 pb-3 pt-2 shadow-soft-lg backdrop-blur-md sm:hidden"
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className="block rounded-[8px] px-2 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              {link.label}
            </Link>
          ))}
          {!signedIn && (
            <Link
              href="/sign-in"
              onClick={() => setMenuOpen(false)}
              className="block rounded-[8px] px-2 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Sign in
            </Link>
          )}
        </nav>
      )}
    </header>
  );
}
