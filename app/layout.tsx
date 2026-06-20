import type { Metadata } from "next";
import { Geist } from "next/font/google";
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

// Geist — Vercel's grotesk. Cleaner, more characterful UI feel than Roboto.
// Variable font, so a single load covers the full weight range we use.
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SwipeIn — LinkedIn Viral Posts Swipe File",
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
        className={`${geist.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
