import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

// Reference-style neutral Clerk theme — near-black primary (matches the app's
// --primary), white inputs, faint borders. Kept in sync with globals.css :root.
const clerkAppearance = {
  variables: {
    colorPrimary: "#1C1C1A",
    colorText: "#1C1C1A",
    colorTextSecondary: "#8A8A86",
    colorBackground: "#FFFFFF",
    colorInputBackground: "#FFFFFF",
    colorInputText: "#1C1C1A",
    colorNeutral: "#1C1C1A",
    borderRadius: "0.625rem",
    fontFamily: "var(--font-geist), ui-sans-serif, system-ui, sans-serif",
  },
};

// Geist (Vercel's grotesk) for body + UI. Variable, so a single load covers the
// full weight range we use.
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

// Geist Mono for the rare numeric / code bit. Variable, paired with Geist.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "SwipeIn · Research, draft, and schedule your LinkedIn content",
  description:
    "SwipeIn tracks what's working on LinkedIn, drafts your next post in your voice with AI, and lets you plan or schedule it from one calendar.",
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
        className={`${geist.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
