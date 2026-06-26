import type { Metadata } from "next";
import { Geist, Geist_Mono, Bricolage_Grotesque } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const clerkAppearance = {
  variables: {
    colorPrimary: "#D77251",
    colorText: "#37322F",
    colorTextSecondary: "#605A57",
    colorBackground: "#FBFAF9",
    colorInputBackground: "#FBFAF9",
    colorInputText: "#37322F",
    borderRadius: "0.75rem",
    fontFamily: "var(--font-geist), ui-sans-serif, system-ui, sans-serif",
  },
};

// Geist (Vercel's grotesk) for body + UI. Variable, so a single load covers the
// full weight range we use.
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

// Bricolage Grotesque: a contemporary display grotesque with real character.
// Drives marketing headlines, big stat numerals, and the price. A sans display
// (not a serif) gives the editorial precision without the LLM-serif tell, and
// tabular figures tie the dateline, stats, and $49 together.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
  display: "swap",
});

// Geist Mono for the "press log" voice: eyebrows, the scrape ticker/dateline,
// demo timestamps. Replaces the previous system-mono stack.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SwipeIn · LinkedIn Viral Posts Swipe File",
  description: "Daily-scraped viral LinkedIn posts, templates, and brand-recoloring prompts",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider appearance={clerkAppearance}>
      <html
        lang="en"
        className={`${geist.variable} ${bricolage.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
