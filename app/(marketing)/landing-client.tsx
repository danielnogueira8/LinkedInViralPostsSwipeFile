"use client";

import type React from "react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ClaudeIcon } from "@/components/claude-icon";
import type { LandingStats } from "@/lib/landing-stats";
import { formatStatCount } from "@/lib/landing-stats";

/* ─────────────────────────────────────────────
   Shared atoms — pill Badge, dark pill CTA,
   pale pill ghost CTA, diagonal hatched corner.
   Tokens are inline so this page stays self-contained
   and matches the Brillance template exactly.
   ───────────────────────────────────────────── */

function Badge({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="px-[14px] py-[6px] bg-white shadow-[0px_0px_0px_4px_rgba(55,50,47,0.05)] overflow-hidden rounded-[90px] flex justify-start items-center gap-[8px] border border-[rgba(2,6,23,0.08)] shadow-xs">
      <div className="w-[14px] h-[14px] relative overflow-hidden flex items-center justify-center">
        {icon}
      </div>
      <div className="text-center flex justify-center flex-col text-[#37322F] text-xs font-medium leading-3 font-sans">
        {text}
      </div>
    </div>
  );
}

function PrimaryPill({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="h-10 sm:h-11 md:h-12 px-6 sm:px-8 md:px-10 lg:px-12 py-2 sm:py-[6px] relative bg-[#bc4527] shadow-[0px_0px_0px_2.5px_rgba(255,255,255,0.08)_inset] overflow-hidden rounded-full flex justify-center items-center cursor-pointer hover:bg-[#a13a20] transition-colors"
    >
      <span className="w-20 sm:w-24 md:w-28 lg:w-44 h-[41px] absolute left-0 top-[-0.5px] bg-gradient-to-b from-[rgba(255,255,255,0)] to-[rgba(0,0,0,0.10)] mix-blend-multiply pointer-events-none" />
      <span className="flex flex-col justify-center text-white text-sm sm:text-base md:text-[15px] font-medium leading-5 font-sans">
        {label}
      </span>
    </Link>
  );
}

function GhostPill({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="h-10 sm:h-11 md:h-12 px-6 sm:px-8 md:px-10 lg:px-12 py-2 sm:py-[6px] relative bg-white shadow-[0px_1px_2px_rgba(55,50,47,0.12)] border border-[rgba(2,6,23,0.08)] overflow-hidden rounded-full flex justify-center items-center cursor-pointer hover:bg-[#FBFAF9] transition-colors"
    >
      <span className="flex flex-col justify-center text-[#37322F] text-sm sm:text-base md:text-[15px] font-medium leading-5 font-sans">
        {label}
      </span>
    </Link>
  );
}

function DiagonalHatch({
  rows = 50,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div className={`w-4 sm:w-6 md:w-8 lg:w-12 self-stretch relative overflow-hidden ${className}`}>
      <div className="w-[120px] sm:w-[140px] md:w-[162px] left-[-40px] sm:left-[-50px] md:left-[-58px] top-[-120px] absolute flex flex-col justify-start items-start">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="self-stretch h-3 sm:h-4 rotate-[-45deg] origin-top-left outline outline-[0.5px] outline-[rgba(3,7,18,0.08)] outline-offset-[-0.25px]"
          />
        ))}
      </div>
    </div>
  );
}

/* Icons (inline SVG to match the template's tiny pixel-art style) */
const I = {
  flame: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M6 1.5C6 1.5 3.5 4 3.5 6.5C3.5 8.43 4.93 10 6.5 10C8.07 10 9.5 8.43 9.5 6.5C9.5 5.5 9 4.5 8 4C8 5 7 5.5 6.5 5.5C6.5 4 6 2.5 6 1.5Z"
        stroke="#37322F"
        strokeWidth="1"
        fill="none"
      />
    </svg>
  ),
  grid: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <rect x="1" y="1" width="4" height="4" stroke="#37322F" strokeWidth="1" fill="none" />
      <rect x="7" y="1" width="4" height="4" stroke="#37322F" strokeWidth="1" fill="none" />
      <rect x="1" y="7" width="4" height="4" stroke="#37322F" strokeWidth="1" fill="none" />
      <rect x="7" y="7" width="4" height="4" stroke="#37322F" strokeWidth="1" fill="none" />
    </svg>
  ),
  star: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M6 1L7.5 4.5L11 5L8.5 7.5L9 11L6 9.25L3 11L3.5 7.5L1 5L4.5 4.5L6 1Z"
        stroke="#37322F"
        strokeWidth="1"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  ),
  dollar: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M6 1V11M8.5 3H4.75C4.28587 3 3.84075 3.18437 3.51256 3.51256C3.18437 3.84075 3 4.28587 3 4.75C3 5.21413 3.18437 5.65925 3.51256 5.98744C3.84075 6.31563 4.28587 6.5 4.75 6.5H7.25C7.71413 6.5 8.15925 6.68437 8.48744 7.01256C8.81563 7.34075 9 7.78587 9 8.25C9 8.71413 8.81563 9.15925 8.48744 9.48744C8.15925 9.81563 7.71413 10 7.25 10H3.5"
        stroke="#37322F"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  question: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="4.5" stroke="#37322F" strokeWidth="1" fill="none" />
      <path
        d="M4.75 4.5C4.75 3.8 5.3 3.25 6 3.25C6.7 3.25 7.25 3.8 7.25 4.5C7.25 5.2 6 5.5 6 6.5"
        stroke="#37322F"
        strokeWidth="1"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="6" cy="8.25" r="0.5" fill="#37322F" />
    </svg>
  ),
  check: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M10 3L4.5 8.5L2 6"
        stroke="#9CA3AF"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  checkOrange: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path
        d="M10 3L4.5 8.5L2 6"
        stroke="#FF8000"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

/* ─────────────────────────────────────────────
   Page
   ───────────────────────────────────────────── */

export default function LandingClient({ stats }: { stats: LandingStats }) {
  const [activeCard, setActiveCard] = useState(0);
  const [progress, setProgress] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!mountedRef.current) return;
      setProgress((p) => {
        if (p >= 100) {
          if (mountedRef.current) setActiveCard((c) => (c + 1) % 3);
          return 0;
        }
        return p + 2;
      });
    }, 100);
    return () => {
      clearInterval(interval);
      mountedRef.current = false;
    };
  }, []);

  const handleCardClick = (i: number) => {
    if (!mountedRef.current) return;
    setActiveCard(i);
    setProgress(0);
  };

  return (
    <div className="w-full min-h-screen relative bg-[#F7F5F3] overflow-x-hidden flex flex-col justify-start items-center -mt-16">
      <div className="relative flex flex-col justify-start items-center w-full">
        <div className="w-full max-w-none px-4 sm:px-6 md:px-8 lg:px-0 lg:max-w-[1060px] lg:w-[1060px] relative flex flex-col justify-start items-start min-h-screen">
          {/* Left vertical rule */}
          <div className="w-[1px] h-full absolute left-4 sm:left-6 md:left-8 lg:left-0 top-0 bg-[rgba(55,50,47,0.12)] shadow-[1px_0px_0px_white] z-0" />
          {/* Right vertical rule */}
          <div className="w-[1px] h-full absolute right-4 sm:right-6 md:right-8 lg:right-0 top-0 bg-[rgba(55,50,47,0.12)] shadow-[1px_0px_0px_white] z-0" />

          <div className="self-stretch pt-[9px] overflow-hidden border-b border-[rgba(55,50,47,0.06)] flex flex-col justify-center items-center gap-4 sm:gap-6 md:gap-8 lg:gap-[66px] relative z-10">
            {/* Hero */}
            <Hero
              activeCard={activeCard}
              progress={progress}
              onCardClick={handleCardClick}
            />

            {/* Numbers */}
            <NumbersSection stats={stats} />

            {/* Bento */}
            <BentoSection />

            {/* Pricing */}
            <PricingSection />

            {/* FAQ */}
            <FAQSection />

            {/* CTA */}
            <CTASection />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── HERO ─────────────────────────── */

function Hero({
  activeCard,
  progress,
  onCardClick,
}: {
  activeCard: number;
  progress: number;
  onCardClick: (i: number) => void;
}) {
  return (
    <div className="pt-16 sm:pt-20 md:pt-24 lg:pt-[180px] pb-8 sm:pb-12 md:pb-16 flex flex-col justify-start items-center px-2 sm:px-4 md:px-8 lg:px-0 w-full">
      <div className="w-full max-w-[937px] lg:w-[937px] flex flex-col justify-center items-center gap-6">
        <Badge
          icon={<ClaudeIcon variant="brand" className="h-[14px] w-[14px]" />}
          text="Get viral LinkedIn Posts inside Claude"
        />
        <div className="flex items-center justify-center gap-2 flex-wrap text-center">
          <span className="swipein-text text-sm sm:text-base md:text-lg font-medium font-sans">
            Meet
          </span>
          <Image
            src="/swipeIntypography.png"
            alt="SwipeIn"
            width={320}
            height={80}
            className="h-12 sm:h-16 md:h-20 w-auto"
          />
          <span className="swipein-text text-sm sm:text-base md:text-lg font-medium font-sans">
            — your LinkedIn viral posts swipe file
          </span>
        </div>
        <div className="self-stretch rounded-[3px] flex flex-col justify-center items-center gap-4 sm:gap-5 md:gap-6 lg:gap-8">
          <h1 className="w-full max-w-[840px] lg:w-[840px] text-center text-[#37322F] text-[28px] sm:text-[40px] md:text-[60px] lg:text-[80px] font-bold leading-[1.05] sm:leading-[1.08] md:leading-[1.1] lg:leading-[88px] font-serif px-2 sm:px-4 md:px-0">
            A daily swipe file of
            <br />
            viral LinkedIn posts.
          </h1>
          <p className="w-full max-w-[620px] lg:w-[620px] text-center text-[rgba(55,50,47,0.80)] text-sm sm:text-base md:text-lg lg:text-lg leading-[1.45] sm:leading-[1.5] md:leading-7 font-sans font-medium px-2 sm:px-4 md:px-0">
            We scrape and template the top posts from up to 100 creators every
            morning — then plug straight into Claude via MCP. Stop scrolling
            LinkedIn. Just ask Claude to find your next post and write it.
          </p>
        </div>
      </div>

      <div className="flex justify-center items-center gap-3 sm:gap-4 relative z-10 mt-6 sm:mt-8 md:mt-10 lg:mt-12">
        <PrimaryPill href="/sign-up" label="Start for free" />
        <GhostPill href="#pricing" label="See pricing" />
      </div>

      {/* Soft mask gradient backdrop behind the dashboard frame */}
      <div className="absolute top-[232px] sm:top-[248px] md:top-[264px] lg:top-[300px] left-1/2 transform -translate-x-1/2 z-0 pointer-events-none w-[936px] sm:w-[1404px] md:w-[2106px] lg:w-[2808px] max-w-none">
        <svg
          viewBox="0 0 800 400"
          className="w-full h-auto opacity-40 mix-blend-multiply"
          aria-hidden
        >
          <defs>
            <radialGradient id="heroGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#FFB37A" stopOpacity="0.55" />
              <stop offset="55%" stopColor="#FFD9B8" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#F7F5F3" stopOpacity="0" />
            </radialGradient>
          </defs>
          <ellipse cx="400" cy="200" rx="380" ry="180" fill="url(#heroGlow)" />
        </svg>
      </div>

      {/* Hero dashboard frame */}
      <div className="w-full max-w-[960px] lg:w-[960px] pt-2 sm:pt-4 pb-6 sm:pb-8 md:pb-10 px-2 sm:px-4 md:px-6 lg:px-11 flex flex-col justify-center items-center gap-2 relative z-5 my-8 sm:my-12 md:my-16 lg:my-16 mb-0 lg:pb-0">
        <div className="w-full max-w-[960px] lg:w-[960px] h-[200px] sm:h-[280px] md:h-[450px] lg:h-[560px] bg-white shadow-[0px_0px_0px_0.9056603908538818px_rgba(0,0,0,0.08)] overflow-hidden rounded-[6px] sm:rounded-[8px] lg:rounded-[9.06px] flex flex-col justify-start items-start">
          <div className="self-stretch flex-1 flex justify-start items-start relative">
            <DashboardSlide active={activeCard === 0}>
              <Image
                src="/dashboard.png"
                alt="Swipe File dashboard — viral posts by engagement"
                fill
                priority
                sizes="(min-width: 1024px) 960px, 100vw"
                className="object-cover object-top"
              />
            </DashboardSlide>
            <DashboardSlide active={activeCard === 1}>
              <SyntheticTemplatesView />
            </DashboardSlide>
            <DashboardSlide active={activeCard === 2}>
              <SyntheticBrandView />
            </DashboardSlide>
          </div>
        </div>
      </div>

      {/* Feature card row */}
      <div className="self-stretch border-t border-[#E0DEDB] border-b border-[#E0DEDB] flex justify-center items-start">
        <DiagonalHatch />
        <div className="flex-1 px-0 sm:px-2 md:px-0 flex flex-col md:flex-row justify-center items-stretch gap-0">
          <FeatureCard
            title="The viral swipe file"
            description="Top posts from up to 100 creators, scraped overnight and ranked by engagement."
            isActive={activeCard === 0}
            progress={activeCard === 0 ? progress : 0}
            onClick={() => onCardClick(0)}
          />
          <FeatureCard
            title="Agent-ready templates"
            description="Every viral post auto-templated and queryable by Claude. Ask, adapt, ship."
            isActive={activeCard === 1}
            progress={activeCard === 1 ? progress : 0}
            onClick={() => onCardClick(1)}
          />
          <FeatureCard
            title="Brand-recolored graphics"
            description="Store each brand's palette once. We recolor every post graphic to match."
            isActive={activeCard === 2}
            progress={activeCard === 2 ? progress : 0}
            onClick={() => onCardClick(2)}
          />
        </div>
        <DiagonalHatch />
      </div>
    </div>
  );
}

function DashboardSlide({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`absolute inset-0 transition-all duration-500 ease-in-out ${
        active ? "opacity-100 scale-100 blur-0" : "opacity-0 scale-95 blur-sm"
      }`}
    >
      <div className="relative w-full h-full">{children}</div>
    </div>
  );
}

function FeatureCard({
  title,
  description,
  isActive,
  progress,
  onClick,
}: {
  title: string;
  description: string;
  isActive: boolean;
  progress: number;
  onClick: () => void;
}) {
  return (
    <div
      className={`w-full md:flex-1 self-stretch px-6 py-5 overflow-hidden flex flex-col justify-start items-start gap-2 cursor-pointer relative border-b md:border-b-0 last:border-b-0 ${
        isActive
          ? "bg-white shadow-[0px_0px_0px_0.75px_#E0DEDB_inset]"
          : "border-l-0 border-r-0 md:border border-[#E0DEDB]/80"
      }`}
      onClick={onClick}
    >
      {isActive && (
        <div className="absolute top-0 left-0 w-full h-0.5 bg-[rgba(50,45,43,0.08)]">
          <div
            className="h-full bg-[#322D2B] transition-all duration-100 ease-linear"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      <div className="self-stretch text-[#49423D] text-sm font-semibold leading-6 font-sans">
        {title}
      </div>
      <div className="self-stretch text-[#605A57] text-[13px] font-normal leading-[22px] font-sans">
        {description}
      </div>
    </div>
  );
}

/* Synthetic views for slides 2 + 3 — built in HTML/CSS to match brand */

function SyntheticTemplatesView() {
  return (
    <div className="w-full h-full bg-[#F7F5F3] p-6 md:p-10 flex flex-col gap-4 md:gap-5">
      <div className="flex items-center gap-2">
        <div className="px-2 py-0.5 bg-[#37322F] text-white text-[10px] font-medium font-sans rounded-full">
          TEMPLATE
        </div>
        <div className="text-[#605A57] text-[11px] font-sans">
          Generated from Lara Acosta · 12.4k ♥
        </div>
      </div>
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-[#E0DEDB] rounded-md p-5 md:p-6 shadow-[0px_2px_4px_rgba(50,45,43,0.04)]">
          <div className="text-[#37322F] font-serif text-2xl md:text-3xl leading-tight">
            I made{" "}
            <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">
              [$ amount]
            </span>{" "}
            from{" "}
            <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">
              [channel]
            </span>{" "}
            in{" "}
            <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">
              [years]
            </span>{" "}
            years.
          </div>
          <div className="mt-4 text-[#605A57] text-sm font-sans leading-6">
            Here are the{" "}
            <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">
              [N]
            </span>{" "}
            frameworks I&apos;d teach my younger self...
          </div>
          <div className="mt-5 flex flex-col gap-2 text-[#605A57] text-sm font-sans">
            <div>1. <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">[framework one]</span></div>
            <div>2. <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">[framework two]</span></div>
            <div>3. <span className="bg-[#FFF3E8] text-[#37322F] px-1.5 rounded-sm">[framework three]</span></div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <div className="bg-white border border-[#E0DEDB] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.04)]">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#605A57] font-sans font-medium">
              Hook pattern
            </div>
            <div className="mt-2 text-[#37322F] font-serif text-lg leading-tight">
              Specific number + outcome + timeframe
            </div>
          </div>
          <div className="bg-white border border-[#E0DEDB] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.04)]">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#605A57] font-sans font-medium">
              Avg. engagement
            </div>
            <div className="mt-2 text-[#37322F] font-serif text-3xl leading-none">
              8,247
            </div>
            <div className="mt-1 text-[#847971] text-xs font-sans">
              across 47 similar posts
            </div>
          </div>
          <div className="bg-[#37322F] text-white rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.08)]">
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#D2C6BF] font-sans font-medium">
              Copied
            </div>
            <div className="mt-2 text-[#FBFAF9] font-sans text-sm">
              Ready to paste · 0.4s ago
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SyntheticBrandView() {
  const palettes = [
    {
      name: "Acme Co",
      colors: ["#0F172A", "#3B82F6", "#F8FAFC"],
      active: true,
    },
    { name: "Bloom Studio", colors: ["#7C3AED", "#F472B6", "#FDF4FF"] },
    { name: "Northwind", colors: ["#0E7490", "#FACC15", "#F0FDF4"] },
  ];
  return (
    <div className="w-full h-full bg-[#F7F5F3] p-6 md:p-10 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-5 md:gap-6">
      <div className="flex flex-col gap-3">
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#605A57] font-sans font-medium">
          Your clients
        </div>
        {palettes.map((p) => (
          <div
            key={p.name}
            className={`flex items-center justify-between rounded-md border px-3.5 py-3 ${
              p.active
                ? "bg-white border-[#E0DEDB] shadow-[0px_0px_0px_0.75px_#E0DEDB_inset]"
                : "bg-transparent border-[#E0DEDB]"
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className="flex -space-x-1">
                {p.colors.map((c) => (
                  <div
                    key={c}
                    className="h-5 w-5 rounded-full border-2 border-[#F7F5F3]"
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
              <div className="text-[#37322F] text-sm font-medium font-sans">
                {p.name}
              </div>
            </div>
            {p.active && (
              <div className="text-[10px] text-[#37322F] font-mono uppercase tracking-[0.14em]">
                Active
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <div className="text-[11px] uppercase tracking-[0.14em] text-[#605A57] font-sans font-medium">
          Recolored — Acme Co
        </div>
        <div className="flex-1 grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-md border border-[#E0DEDB] overflow-hidden bg-white shadow-[0px_2px_4px_rgba(50,45,43,0.04)] flex flex-col"
            >
              <div className="aspect-[4/3] relative overflow-hidden bg-gradient-to-br from-[#0F172A] via-[#1E3A8A] to-[#3B82F6]">
                <svg className="absolute inset-0 w-full h-full" viewBox="0 0 100 75">
                  <circle cx={20 + i * 8} cy="30" r="18" fill="#F8FAFC" opacity="0.18" />
                  <rect
                    x="10"
                    y="50"
                    width="70"
                    height="4"
                    rx="2"
                    fill="#F8FAFC"
                    opacity="0.5"
                  />
                  <rect
                    x="10"
                    y="58"
                    width="45"
                    height="3"
                    rx="1.5"
                    fill="#F8FAFC"
                    opacity="0.3"
                  />
                </svg>
              </div>
              <div className="px-3 py-2 text-[10px] text-[#605A57] font-sans">
                graphic_{String(i + 1).padStart(2, "0")}.png
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── NUMBERS ─────────────────────────── */

function NumbersSection({ stats }: { stats: LandingStats }) {
  // Live counts from lib/landing-stats. formatStatCount keeps small numbers
  // exact ("847") and abbreviates only once they pass 1k — looking like a
  // real, growing number rather than a fluffy "12k" placeholder.
  const display = [
    { label: "Creators tracked", value: formatStatCount(stats.creatorsTracked) },
    { label: "Posts pulled today", value: formatStatCount(stats.postsPulledToday) },
    { label: "Viral posts archived", value: formatStatCount(stats.viralPostsArchived) },
    { label: "Templates generated", value: formatStatCount(stats.templatesGenerated) },
  ];
  return (
    <div className="w-full border-b border-[rgba(55,50,47,0.12)] flex flex-col justify-center items-center">
      <div className="self-stretch px-4 sm:px-6 md:px-24 py-10 sm:py-12 md:py-16 border-b border-[rgba(55,50,47,0.12)] flex justify-center items-center gap-6">
        <div className="w-full max-w-[586px] flex flex-col justify-start items-center gap-3 sm:gap-4">
          <Badge icon={I.star} text="Built for LinkedIn content creators" />
          <h2 className="w-full max-w-[472.55px] text-center text-[#49423D] text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-semibold leading-tight md:leading-[60px] font-sans tracking-tight">
            The intel layer behind 12,000+ viral posts
          </h2>
          <p className="self-stretch text-center text-[#605A57] text-sm sm:text-base font-normal leading-6 sm:leading-7 font-sans">
            Ghostwriters, founders, marketers, agencies. Anyone shipping posts
            on LinkedIn. Skip the scroll, skip the spreadsheet, ask Claude.
          </p>
        </div>
      </div>

      <div className="self-stretch flex justify-center items-stretch">
        <DiagonalHatch />
        <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-0 border-l border-r border-[rgba(55,50,47,0.12)]">
          {display.map((s, i) => (
            <div
              key={s.label}
              className={`h-24 sm:h-28 md:h-32 lg:h-40 flex flex-col justify-center items-center gap-1 px-4 ${
                i < display.length - 1
                  ? "border-r-[0.5px] border-[#E3E2E1]"
                  : ""
              } ${i < 2 ? "border-b sm:border-b-0 border-[#E3E2E1]" : ""}`}
            >
              <div className="text-[#37322F] text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-normal leading-none font-serif">
                {s.value}
              </div>
              <div className="text-[#605A57] text-[11px] sm:text-xs md:text-sm font-sans">
                {s.label}
              </div>
            </div>
          ))}
        </div>
        <DiagonalHatch />
      </div>
    </div>
  );
}

/* ─────────────────────────── BENTO ─────────────────────────── */

function BentoSection() {
  return (
    <div className="w-full border-b border-[rgba(55,50,47,0.12)] flex flex-col justify-center items-center">
      <div className="self-stretch px-4 sm:px-6 md:px-8 lg:px-0 lg:max-w-[1060px] lg:w-[1060px] py-10 sm:py-12 md:py-16 border-b border-[rgba(55,50,47,0.12)] flex justify-center items-center gap-6">
        <div className="w-full max-w-[616px] lg:w-[616px] flex flex-col justify-start items-center gap-3 sm:gap-4">
          <Badge icon={I.grid} text="What's inside" />
          <h2 className="w-full max-w-[598px] lg:w-[598px] text-center text-[#49423D] text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-semibold leading-tight md:leading-[60px] font-sans tracking-tight">
            A swipe file Claude can actually use
          </h2>
          <p className="self-stretch text-center text-[#605A57] text-sm sm:text-base font-normal leading-6 sm:leading-7 font-sans">
            Every post, template, and signal is exposed to Claude via MCP.
            <br className="hidden sm:block" /> Stop hunting through spreadsheets
            — just ask the agent what works.
          </p>
        </div>
      </div>

      <div className="self-stretch flex justify-center items-start">
        <DiagonalHatch rows={200} />
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-0 border-l border-r border-[rgba(55,50,47,0.12)]">
          <BentoCell
            border="b-r"
            title="Claude MCP — talk to your swipe file"
            blurb="One-click connector for claude.ai. Ask Claude what's working, add accounts, generate a draft — all without leaving chat."
          >
            <BentoMCPVisual />
          </BentoCell>
          <BentoCell
            border="b"
            title="Daily-scraped viral feed"
            blurb="Every morning at 06:00 UTC. Filter by niche, date, or virality threshold — or just have the agent do it for you."
          >
            <BentoSwipeVisual />
          </BentoCell>
          <BentoCell
            border="b-r"
            title="Agent-ready templates"
            blurb="Every viral post turned into a structured template Claude can fill in with your voice, your offer, your story."
          >
            <BentoTemplateVisual />
          </BentoCell>
          <BentoCell
            border="b"
            title="Lead-magnet detection"
            blurb="We tag the ‘comment PLAYBOOK’ posts pulling 2k+ DMs so you (and Claude) can reverse-engineer the offer."
          >
            <BentoLeadMagnetVisual />
          </BentoCell>
        </div>
        <DiagonalHatch rows={200} />
      </div>
    </div>
  );
}

function BentoCell({
  border,
  title,
  blurb,
  children,
}: {
  border: "b" | "b-r";
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  const borderClass =
    border === "b-r"
      ? "border-b border-r-0 md:border-r border-[rgba(55,50,47,0.12)]"
      : "border-b border-[rgba(55,50,47,0.12)]";
  return (
    <div
      className={`${borderClass} p-4 sm:p-6 md:p-8 lg:p-12 flex flex-col justify-start items-start gap-4 sm:gap-6`}
    >
      <div className="flex flex-col gap-2">
        <h3 className="text-[#37322F] text-lg sm:text-xl font-semibold leading-tight font-sans">
          {title}
        </h3>
        <p className="text-[#605A57] text-sm md:text-base font-normal leading-relaxed font-sans">
          {blurb}
        </p>
      </div>
      <div className="w-full h-[200px] sm:h-[230px] md:h-[280px] rounded-lg overflow-hidden flex items-center justify-center relative">
        {children}
        <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-[#F7F5F3] to-transparent pointer-events-none" />
      </div>
    </div>
  );
}

/* Bento visuals — all in HTML/SVG, no external assets */

function BentoSwipeVisual() {
  const posts = [
    {
      author: "Lara Acosta",
      tint: "bg-rose-100 text-rose-700",
      initials: "LA",
      preview: "I made $2M from LinkedIn in 2 years…",
      reactions: "12.4k",
    },
    {
      author: "Justin Welsh",
      tint: "bg-emerald-100 text-emerald-700",
      initials: "JW",
      preview: "Most people overcomplicate writing on LinkedIn.",
      reactions: "8.9k",
    },
    {
      author: "Hatice Kamran",
      tint: "bg-violet-100 text-violet-700",
      initials: "HK",
      preview: "Comment PLAYBOOK and I'll DM you the full guide…",
      reactions: "5.2k",
    },
  ];
  return (
    <div className="w-full h-full flex flex-col gap-2 pt-1">
      {posts.map((p, i) => (
        <div
          key={p.author}
          className={`flex items-start gap-3 bg-white border border-[#E0DEDB] rounded-md px-3.5 py-2.5 shadow-[0px_2px_4px_rgba(50,45,43,0.04)] ${
            i === 1 ? "md:translate-x-2" : ""
          }`}
        >
          <div
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${p.tint}`}
          >
            {p.initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[#37322F] text-[12.5px] font-semibold leading-tight font-sans">
              {p.author}
            </div>
            <div className="mt-1 text-[#605A57] text-[11.5px] line-clamp-1 font-sans">
              {p.preview}
            </div>
          </div>
          <div className="text-[#37322F] text-[11px] font-medium font-sans tabular-nums">
            ♥ {p.reactions}
          </div>
        </div>
      ))}
    </div>
  );
}

function BentoTemplateVisual() {
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 bg-white border border-[#E0DEDB] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.04)] flex flex-col gap-2">
        <div className="text-[#37322F] font-serif text-lg md:text-xl leading-tight">
          The{" "}
          <span className="bg-[#FFF3E8] px-1 rounded-sm">[N]</span>-step
          template I&apos;ve used{" "}
          <span className="bg-[#FFF3E8] px-1 rounded-sm">[X]</span>+ times:
        </div>
        <div className="text-[#605A57] text-sm font-sans space-y-1">
          <div>1. Hook — <span className="bg-[#FFF3E8] px-1 rounded-sm text-[#37322F]">[bold claim]</span></div>
          <div>2. Story — <span className="bg-[#FFF3E8] px-1 rounded-sm text-[#37322F]">[your proof]</span></div>
          <div>3. Lesson — <span className="bg-[#FFF3E8] px-1 rounded-sm text-[#37322F]">[takeaway]</span></div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-[#605A57] font-sans uppercase tracking-[0.14em] px-1">
        <span>From Justin Welsh · 8.9k ♥</span>
        <span className="text-[#37322F]">Copy ⌘C</span>
      </div>
    </div>
  );
}

function BentoLeadMagnetVisual() {
  return (
    <div className="w-full h-full flex flex-col gap-2">
      <div className="flex-1 bg-white border border-[#E0DEDB] rounded-md p-3.5 shadow-[0px_2px_4px_rgba(50,45,43,0.04)]">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-violet-100 text-violet-700 text-[10px] font-semibold">
            HK
          </div>
          <div className="text-[12px] text-[#37322F] font-semibold font-sans">
            Hatice Kamran
          </div>
          <div className="ml-auto px-2 py-0.5 bg-[#FFF3E8] text-[#9A4F00] text-[9px] font-medium rounded-full uppercase tracking-[0.1em] font-sans">
            Lead Magnet
          </div>
        </div>
        <p className="mt-3 text-[#37322F] font-serif text-base leading-snug">
          Comment <span className="font-semibold">&ldquo;PLAYBOOK&rdquo;</span>{" "}
          and I&apos;ll DM you the 47-page guide free.
        </p>
        <div className="mt-3 flex items-center justify-between rounded bg-[#F7F5F3] px-2.5 py-1.5">
          <span className="text-[10.5px] text-[#605A57] font-sans uppercase tracking-[0.12em]">
            DM intent
          </span>
          <span className="text-[#37322F] text-[12px] font-semibold font-sans">
            94 / 100
          </span>
        </div>
      </div>
      <div className="text-[10px] text-[#605A57] font-sans uppercase tracking-[0.14em] px-1">
        1.8k DMs triggered · 2 days ago
      </div>
    </div>
  );
}

function BentoMCPVisual() {
  return (
    <div className="w-full h-full bg-[#37322F] rounded-md p-4 shadow-[0px_2px_4px_rgba(50,45,43,0.08)] font-mono text-[11px] md:text-[12px] leading-relaxed text-[#F0EFEE] flex flex-col">
      <div className="flex items-center gap-1.5 text-[10px] text-[#B2AEA9]">
        <ClaudeIcon variant="brand" className="h-3 w-3" />
        claude · swipe-file connected
      </div>
      <div className="mt-3 text-[#FFB37A]">
        &gt; what hooks worked best last week?
      </div>
      <div className="mt-2 text-[#F0EFEE]">Top 3 hook patterns:</div>
      <div className="mt-1 text-[#D2C6BF]">
        1. &ldquo;I made $X from Y…&rdquo;{" "}
        <span className="text-[#FFB37A]">(8 viral)</span>
      </div>
      <div className="text-[#D2C6BF]">
        2. &ldquo;Stop doing X. Do Y…&rdquo;{" "}
        <span className="text-[#FFB37A]">(6 viral)</span>
      </div>
      <div className="text-[#D2C6BF]">
        3. &ldquo;Comment WORD and I&apos;ll DM…&rdquo;{" "}
        <span className="text-[#FFB37A]">(4 viral)</span>
      </div>
    </div>
  );
}

/* ─────────────────────────── PRICING ─────────────────────────── */

function PricingSection() {
  return (
    <div id="pricing" className="w-full flex flex-col justify-center items-center gap-2">
      <div className="self-stretch px-4 sm:px-6 md:px-24 py-10 sm:py-12 md:py-16 border-b border-[rgba(55,50,47,0.12)] flex justify-center items-center gap-6">
        <div className="w-full max-w-[586px] flex flex-col justify-start items-center gap-3 sm:gap-4">
          <Badge icon={I.dollar} text="Plans & Pricing" />
          <h2 className="self-stretch text-center text-[#49423D] text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-semibold leading-tight md:leading-[60px] font-sans tracking-tight">
            One plan. Everything included.
          </h2>
          <p className="self-stretch text-center text-[#605A57] text-sm sm:text-base font-normal leading-6 sm:leading-7 font-sans">
            No tiers, no add-ons, no upsells. Cancel anytime.
          </p>
        </div>
      </div>

      <div className="self-stretch border-b border-t border-[rgba(55,50,47,0.12)] flex justify-center items-center">
        <div className="flex justify-center items-stretch w-full">
          <DiagonalHatch rows={120} className="hidden md:block" />
          <div className="flex-1 flex flex-col md:flex-row justify-center items-stretch gap-6 py-10 md:py-12 px-4 md:px-12">
            {/* Free trial card */}
            <div className="flex-1 max-w-full md:max-w-[360px] self-stretch px-6 py-6 border border-[#E0DEDB] overflow-hidden flex flex-col justify-start items-start gap-10 bg-transparent rounded-md">
              <div className="self-stretch flex flex-col justify-start items-start gap-9">
                <div className="self-stretch flex flex-col gap-2">
                  <div className="text-[rgba(55,50,47,0.90)] text-lg font-medium leading-7 font-sans">
                    Free trial
                  </div>
                  <div className="w-full max-w-[242px] text-[rgba(41,37,35,0.70)] text-sm font-normal leading-5 font-sans">
                    Full access. No credit card required.
                  </div>
                </div>
                <div className="self-stretch flex flex-col gap-1">
                  <div className="h-[60px] flex items-center text-[#37322F] text-5xl font-medium leading-[60px] font-serif">
                    $0
                  </div>
                  <div className="text-[#847971] text-sm font-medium font-sans">
                    for 7 days, then $49/mo
                  </div>
                </div>
                <Link
                  href="/sign-up"
                  className="self-stretch px-4 py-[10px] relative bg-[#37322F] shadow-[0px_2px_4px_rgba(55,50,47,0.12)] overflow-hidden rounded-[99px] flex justify-center items-center"
                >
                  <span className="w-full h-[41px] absolute left-0 top-[-0.5px] bg-gradient-to-b from-[rgba(255,255,255,0.20)] to-[rgba(0,0,0,0.10)] mix-blend-multiply pointer-events-none" />
                  <span className="text-[#FBFAF9] text-[13px] font-medium leading-5 font-sans">
                    Start free trial
                  </span>
                </Link>
              </div>
              <div className="self-stretch flex flex-col gap-2">
                {[
                  "Track up to 100 creators",
                  "Daily viral post scraping",
                  "Auto-generated post templates",
                  "Lead-magnet detection",
                  "Standard email support",
                ].map((f) => (
                  <PricingFeature key={f} text={f} accent={false} />
                ))}
              </div>
            </div>

            {/* Pro card — featured, dark */}
            <div className="flex-1 max-w-full md:max-w-[360px] self-stretch px-6 py-6 bg-[#37322F] border border-[rgba(55,50,47,0.12)] overflow-hidden flex flex-col justify-start items-start gap-10 rounded-md">
              <div className="self-stretch flex flex-col gap-9">
                <div className="self-stretch flex items-start justify-between">
                  <div className="flex flex-col gap-2">
                    <div className="text-[#FBFAF9] text-lg font-medium leading-7 font-sans">
                      Pro
                    </div>
                    <div className="w-full max-w-[242px] text-[#B2AEA9] text-sm font-normal leading-5 font-sans">
                      The full swipe file + Claude MCP. Ship LinkedIn posts by asking, not scrolling.
                    </div>
                  </div>
                  <div className="shrink-0 whitespace-nowrap px-2 py-0.5 bg-[#FF8000]/15 text-[#FF8000] text-[10px] font-medium rounded-full uppercase tracking-[0.1em] font-sans">
                    Most popular
                  </div>
                </div>
                <div className="self-stretch flex flex-col gap-1">
                  <div className="h-[60px] flex items-baseline gap-2 text-[#F0EFEE] text-5xl font-medium leading-[60px] font-serif">
                    $49
                    <span className="text-[#D2C6BF] text-base font-sans font-medium">
                      /month
                    </span>
                  </div>
                  <div className="text-[#D2C6BF] text-sm font-medium font-sans">
                    billed monthly · cancel anytime
                  </div>
                </div>
                <Link
                  href="/sign-up"
                  className="self-stretch px-4 py-[10px] relative bg-[#FBFAF9] shadow-[0px_2px_4px_rgba(55,50,47,0.12)] overflow-hidden rounded-[99px] flex justify-center items-center"
                >
                  <span className="w-full h-[41px] absolute left-0 top-[-0.5px] bg-gradient-to-b from-[rgba(255,255,255,0)] to-[rgba(0,0,0,0.10)] mix-blend-multiply pointer-events-none" />
                  <span className="text-[#37322F] text-[13px] font-medium leading-5 font-sans">
                    Get started
                  </span>
                </Link>
              </div>
              <div className="self-stretch flex flex-col gap-2">
                {[
                  "Everything in Free",
                  "Claude MCP connector (claude.ai)",
                  "Agent-ready post templates",
                  "Brand-recolored graphics",
                  "Unlimited swipe file access",
                  "Per-brand palette storage",
                  "Priority email support",
                ].map((f) => (
                  <PricingFeature key={f} text={f} accent dark />
                ))}
              </div>
            </div>
          </div>
          <DiagonalHatch rows={120} className="hidden md:block" />
        </div>
      </div>
    </div>
  );
}

function PricingFeature({
  text,
  accent,
  dark,
}: {
  text: string;
  accent: boolean;
  dark?: boolean;
}) {
  return (
    <div className="self-stretch flex items-center gap-[13px]">
      <div className="w-4 h-4 flex items-center justify-center">
        {accent ? I.checkOrange : I.check}
      </div>
      <div
        className={`flex-1 text-[12.5px] font-normal leading-5 font-sans ${
          dark ? "text-[#F0EFEE]" : "text-[rgba(55,50,47,0.80)]"
        }`}
      >
        {text}
      </div>
    </div>
  );
}

/* ─────────────────────────── FAQ ─────────────────────────── */

function FAQSection() {
  return (
    <div id="faq" className="w-full border-b border-[rgba(55,50,47,0.12)] flex flex-col justify-center items-center">
      <div className="self-stretch px-4 sm:px-6 md:px-24 py-10 sm:py-12 md:py-16 border-b border-[rgba(55,50,47,0.12)] flex justify-center items-center gap-6">
        <div className="w-full max-w-[586px] flex flex-col justify-start items-center gap-3 sm:gap-4">
          <Badge icon={I.question} text="FAQ" />
          <h2 className="self-stretch text-center text-[#49423D] text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-semibold leading-tight md:leading-[60px] font-sans tracking-tight">
            Questions, answered.
          </h2>
          <p className="self-stretch text-center text-[#605A57] text-sm sm:text-base font-normal leading-6 sm:leading-7 font-sans">
            Still wondering? Email{" "}
            <span className="text-[#37322F] font-medium">
              hello@swipefile.app
            </span>{" "}
            and we&apos;ll respond within a day.
          </p>
        </div>
      </div>

      <div className="self-stretch flex justify-center items-stretch">
        <DiagonalHatch rows={120} />
        <div className="flex-1 px-4 sm:px-6 md:px-12 py-10 md:py-12 border-l border-r border-[rgba(55,50,47,0.12)]">
          <div className="w-full max-w-[760px] mx-auto divide-y divide-[rgba(55,50,47,0.12)]">
            {FAQS.map((qa) => (
              <details
                key={qa.q}
                className="group py-5"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[#37322F] text-base md:text-lg font-medium font-sans">
                  {qa.q}
                  <span className="text-[#605A57] transition-transform group-open:rotate-45 text-xl leading-none font-light">
                    +
                  </span>
                </summary>
                <p className="mt-3 max-w-prose text-[#605A57] text-sm md:text-base leading-relaxed font-sans">
                  {qa.a}
                </p>
              </details>
            ))}
          </div>
        </div>
        <DiagonalHatch rows={120} />
      </div>
    </div>
  );
}

const FAQS = [
  {
    q: "What's the Claude MCP connector?",
    a: "MCP (Model Context Protocol) is how Claude securely talks to external tools. We give you a one-click connector for claude.ai — once connected, you can ask Claude things like 'find the top 5 AI posts from this week and rewrite the best one in my voice' and it answers using your actual swipe file.",
  },
  {
    q: "Do I have to use Claude to get value from this?",
    a: "No. The dashboard, swipe file, templates, and brand-recolored graphics all work standalone. The Claude MCP just turns the whole thing into an agent — ask, don't scroll. Most users use both.",
  },
  {
    q: "Who is this for?",
    a: "Anyone shipping content on LinkedIn — ghostwriters, founders building a personal brand, in-house marketers, agencies, sales teams. If you write LinkedIn posts (or pay someone to), this saves you the daily scrolling tax.",
  },
  {
    q: "How do you actually get the LinkedIn posts?",
    a: "A public-data scraping pipeline (via Apify) pulls public posts daily from the profiles you choose. You add up to 100 creators or competitors per workspace.",
  },
  {
    q: "What does 'brand-recolored graphics' mean?",
    a: "When a viral post includes a graphic, we generate a version recolored to match your (or your client's) brand palette — so you can repurpose proven visuals without manually editing them in Figma.",
  },
  {
    q: "Is there a free plan?",
    a: "There's a 7-day free trial — full access, no credit card required. After that it's $49/month, billed monthly. Cancel anytime.",
  },
  {
    q: "Can I add more than 100 creators?",
    a: "100 is the cap on the Pro plan. If you need more (large agency use cases), email us and we'll work something out.",
  },
];

/* ─────────────────────────── CTA ─────────────────────────── */

function CTASection() {
  return (
    <div className="w-full relative overflow-hidden flex flex-col justify-center items-center gap-2">
      <div className="self-stretch px-4 sm:px-6 md:px-24 py-12 md:py-16 border-t border-b border-[rgba(55,50,47,0.12)] flex justify-center items-center gap-6 relative z-10">
        <div className="absolute inset-0 w-full h-full overflow-hidden">
          <div className="w-full h-full relative">
            {Array.from({ length: 60 }).map((_, i) => (
              <div
                key={i}
                className="absolute h-4 rotate-[-45deg] origin-top-left outline outline-[0.5px] outline-[rgba(3,7,18,0.06)] outline-offset-[-0.25px]"
                style={{
                  top: `${i * 16 - 120}px`,
                  left: "-100%",
                  width: "300%",
                }}
              />
            ))}
          </div>
        </div>

        <div className="w-full max-w-[586px] px-6 py-5 md:py-8 overflow-hidden rounded-lg flex flex-col justify-start items-center gap-6 relative z-20">
          <div className="self-stretch flex flex-col gap-3">
            <h2 className="self-stretch text-center text-[#49423D] text-3xl md:text-5xl font-semibold leading-tight md:leading-[56px] font-sans tracking-tight">
              Stop scrolling. Just ask Claude.
            </h2>
            <p className="self-stretch text-center text-[#605A57] text-base leading-7 font-sans font-medium">
              Join the creators, founders, and agencies who turned
              <br className="hidden sm:block" />
              LinkedIn from a feed into an agent.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <PrimaryPill href="/sign-up" label="Start for free" />
          </div>
          <p className="text-center text-[#847971] text-xs font-sans">
            7 days free · no credit card · cancel anytime
          </p>
        </div>
      </div>
    </div>
  );
}
