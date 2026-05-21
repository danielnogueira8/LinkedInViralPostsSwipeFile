import type { Metadata } from "next";
import { Roboto } from "next/font/google";
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
    fontFamily: "var(--font-roboto), ui-sans-serif, system-ui, sans-serif",
  },
};

const roboto = Roboto({
  variable: "--font-roboto",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "L.A.V.A — LinkedIn Agentic Viral Archive",
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
        className={`${roboto.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
