import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

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
  const { userId } = await auth();
  const signedIn = !!userId;

  return (
    <header className="sticky top-0 z-40 w-full bg-[#F7F5F3]">
      <div className="mx-auto flex h-[84px] w-full max-w-[1060px] items-center justify-center px-6 lg:px-0">
        <div className="absolute left-0 top-[42px] hidden h-0 w-full border-t border-[rgba(55,50,47,0.12)] shadow-[0px_1px_0px_white] md:block" />
        <div className="relative z-30 flex h-12 w-full max-w-[700px] items-center justify-between rounded-[50px] bg-[#F7F5F3] px-4 py-2 pr-3 shadow-[0px_0px_0px_2px_white] backdrop-blur-sm">
          <div className="flex items-center">
            <Link href="/" className="flex items-center">
              <span className="font-sans text-lg font-medium leading-5 text-[#2F3037] md:text-xl">
                Swipe File
              </span>
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

function SiteFooter() {
  return (
    <footer className="border-t border-[rgba(55,50,47,0.12)] bg-[#F7F5F3]">
      <div className="mx-auto w-full max-w-[1060px] px-6 py-12 lg:px-0">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 space-y-3">
            <Link href="/" className="flex items-center">
              <span className="font-sans text-lg font-medium leading-5 text-[#2F3037] md:text-xl">
                Swipe File
              </span>
            </Link>
            <p className="max-w-sm text-sm leading-6 text-[#605A57] font-sans">
              The daily-scraped viral LinkedIn post intel platform for
              founders, ghostwriters, and content teams.
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
          <div>© {new Date().getFullYear()} Swipe File. All rights reserved.</div>
          <div className="font-mono">v0.1</div>
        </div>
      </div>
    </footer>
  );
}
