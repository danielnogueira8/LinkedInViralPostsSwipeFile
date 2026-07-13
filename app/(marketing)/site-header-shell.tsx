"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";

export function SiteHeaderShell({ signedIn }: { signedIn: boolean }) {
  const [scrolled, setScrolled] = useState(false);

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

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b transition-[background-color,backdrop-filter,border-color] duration-200",
        scrolled
          ? "border-border bg-background/88 backdrop-blur-md"
          : "border-transparent bg-background",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center px-4 sm:px-6">
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center">
            <Link href="/" className="flex items-center gap-2.5" aria-label="SwipeIn home">
              <Image
                src="/swipeInIcon.png"
                alt="SwipeIn"
                width={30}
                height={30}
                priority
                className="size-[30px] shrink-0 rounded-[8px]"
              />
              <span className="text-sm font-semibold tracking-[-0.01em]">SwipeIn</span>
            </Link>
            <nav className="ml-8 hidden items-center gap-5 sm:flex" aria-label="Marketing navigation">
              <Link
                href="/#features"
                className="text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Features
              </Link>
              <Link
                href="/#pricing"
                className="text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Pricing
              </Link>
              <Link
                href="/#faq"
                className="text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                FAQ
              </Link>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {signedIn ? (
              <>
                <Link
                  href="/dashboard"
                  className="inline-flex h-10 items-center rounded-[10px] bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] hover:bg-primary/88 active:scale-[0.96] motion-reduce:transition-none"
                >
                  Dashboard
                </Link>
                <UserButton />
              </>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="hidden text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="inline-flex h-10 items-center rounded-[10px] bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-[background-color,scale] hover:bg-primary/88 active:scale-[0.96] motion-reduce:transition-none"
                >
                  Start for free
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
