"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";

// Marketing header: adds a subtle "scrolled" state once the user moves past
// the hero so the sticky bar reads as a separate plane from the page bg.
// Without this the header sits flush on the same cream tone and gives no
// visual signal that you're now in scroll territory.
//
// Implemented as a client shell because the parent layout is async (uses
// auth()). We get `signedIn` from there and own only the scroll-state on
// the client, keeping auth resolution server-side.
export function SiteHeaderShell({ signedIn }: { signedIn: boolean }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // Cheap rAF-throttled listener: passive scroll, one bool flip past 16px.
    // 16px is intentionally small — we want the state to kick in basically
    // as soon as the user starts scrolling, not halfway down the hero.
    let frame = 0;
    function onScroll() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setScrolled(window.scrollY > 16);
      });
    }
    onScroll(); // initial state on mount (in case of refresh mid-page)
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full transition-[background-color,backdrop-filter,border-color,box-shadow] duration-200",
        scrolled
          ? // Translucent bg + blur + faint shadow gives the impression the
            // content slides UNDER the header rather than alongside it.
            "bg-[rgba(247,245,243,0.78)] backdrop-blur-md border-b border-[rgba(55,50,47,0.08)] shadow-[0_1px_0_rgba(255,255,255,0.7)]"
          : "bg-[#F7F5F3]",
      )}
    >
      <div className="mx-auto flex h-[84px] w-full max-w-[1060px] items-center justify-center px-6 lg:px-0">
        <div className="absolute left-0 top-[42px] hidden h-0 w-full border-t border-[rgba(55,50,47,0.12)] shadow-[0px_1px_0px_white] md:block" />
        <div
          className={cn(
            "relative z-30 flex h-12 w-full max-w-[700px] items-center justify-between rounded-[50px] px-4 py-2 pr-3 transition-shadow duration-200",
            // Pill gets a hair more lift on scroll so it visually separates
            // from the now-translucent header bar.
            scrolled
              ? "bg-[rgba(247,245,243,0.92)] backdrop-blur-sm shadow-[0px_0px_0px_2px_white,0px_4px_12px_-4px_rgba(55,50,47,0.18)]"
              : "bg-[#F7F5F3] shadow-[0px_0px_0px_2px_white]",
          )}
        >
          <div className="flex items-center">
            <Link href="/" className="flex items-center">
              <Image
                src="/swipeInIcon.png"
                alt="SwipeIn"
                width={32}
                height={32}
                priority
                className="h-8 w-8 rounded-lg shrink-0"
              />
            </Link>
            <nav className="ml-5 hidden items-center gap-4 sm:flex">
              <Link
                href="/#features"
                className="font-sans text-[13px] font-medium leading-[14px] text-[rgba(49,45,43,0.80)] transition-colors hover:text-[#37322F]"
              >
                Features
              </Link>
              <Link
                href="/#pricing"
                className="font-sans text-[13px] font-medium leading-[14px] text-[rgba(49,45,43,0.80)] transition-colors hover:text-[#37322F]"
              >
                Pricing
              </Link>
              <Link
                href="/#faq"
                className="font-sans text-[13px] font-medium leading-[14px] text-[rgba(49,45,43,0.80)] transition-colors hover:text-[#37322F]"
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
                  className="rounded-full bg-white px-[14px] py-[6px] font-sans text-[13px] font-medium leading-5 text-[#37322F] shadow-[0px_1px_2px_rgba(55,50,47,0.12)] transition-colors hover:bg-[#FBFAF9]"
                >
                  Dashboard
                </Link>
                <UserButton />
              </>
            ) : (
              <>
                <Link
                  href="/sign-in"
                  className="hidden font-sans text-[13px] font-medium leading-[14px] text-[rgba(49,45,43,0.80)] transition-colors hover:text-[#37322F] sm:inline"
                >
                  Sign in
                </Link>
                <Link
                  href="/sign-up"
                  className="rounded-full bg-white px-[14px] py-[6px] font-sans text-[13px] font-medium leading-5 text-[#37322F] shadow-[0px_1px_2px_rgba(55,50,47,0.12)] transition-colors hover:bg-[#FBFAF9]"
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
