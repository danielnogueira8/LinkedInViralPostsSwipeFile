import Link from "next/link";

export const metadata = {
  title: "Terms of Service — Swipe File",
  description: "The rules for using Swipe File.",
};

const EFFECTIVE_DATE = "May 21, 2026";

export default function TermsPage() {
  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[300px] bg-gradient-to-b from-accent/30 to-transparent"
      />

      <section className="mx-auto max-w-3xl px-6 pt-20 pb-20 md:pt-28">
        <h1 className="font-display text-4xl leading-[1.1] tracking-tight md:text-5xl">
          Terms of Service
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Effective {EFFECTIVE_DATE}
        </p>

        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-[#37322F]">
          <Section title="1. Agreement">
            <p>
              These Terms govern your use of Swipe File (the &ldquo;Service&rdquo;),
              operated by Scale Content Labs (&ldquo;we,&rdquo; &ldquo;us&rdquo;). By
              creating an account or using the Service, you agree to these
              Terms and to our{" "}
              <Link
                href="/privacy"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                Privacy Policy
              </Link>
              . If you do not agree, do not use the Service.
            </p>
          </Section>

          <Section title="2. Eligibility and account">
            <p>
              You must be at least 16 years old to use the Service. You are
              responsible for keeping your account credentials secure and for
              all activity that occurs under your account. Notify us promptly
              of any unauthorized use.
            </p>
            <p>
              You agree to provide accurate information when you sign up and
              to keep it current.
            </p>
          </Section>

          <Section title="3. Subscription and billing">
            <p>
              Swipe File is offered as a paid subscription. The current price
              and any free trial terms are listed on our{" "}
              <Link
                href="/pricing"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                pricing page
              </Link>
              .
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Free trial.</strong> If you cancel during the free
                trial period stated on the pricing page, you will not be
                charged.
              </li>
              <li>
                <strong>Renewal.</strong> Subscriptions renew automatically at
                the end of each billing period until you cancel. You can
                cancel at any time from your account.
              </li>
              <li>
                <strong>Refunds.</strong> Refund terms are listed on the
                pricing page. Outside of those terms, fees are non-refundable
                except where required by law.
              </li>
              <li>
                <strong>Taxes.</strong> Prices do not include applicable taxes,
                which you are responsible for.
              </li>
              <li>
                <strong>Price changes.</strong> We may change prices for new
                billing periods with at least 30 days&rsquo; notice by email.
              </li>
            </ul>
          </Section>

          <Section title="4. What the Service does">
            <p>
              Swipe File aggregates public posts from LinkedIn creators that
              you choose to track, generates post templates and brand-recolored
              graphics, and exposes these capabilities through a web app and a
              Claude MCP connector. The Service depends on third-party APIs
              (including LinkedIn data accessed via Apify) and may be subject
              to availability, rate limits, and changes outside our control.
            </p>
          </Section>

          <Section title="5. Acceptable use">
            <p>You agree not to:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                Use the Service to violate any law or another person&rsquo;s
                rights, including intellectual property or privacy rights.
              </li>
              <li>
                Republish or redistribute another creator&rsquo;s posts as if
                they were your own, or use templates to produce content that
                is defamatory, deceptive, or misleading.
              </li>
              <li>
                Resell, sublicense, or expose Swipe File&rsquo;s data to third
                parties as a standalone product.
              </li>
              <li>
                Scrape, reverse-engineer, or interfere with the Service or its
                infrastructure, or attempt to gain unauthorized access.
              </li>
              <li>
                Use the Service to send spam, harass others, or generate
                content that violates LinkedIn&rsquo;s own terms.
              </li>
            </ul>
            <p>
              We may suspend or terminate accounts that violate these rules.
            </p>
          </Section>

          <Section title="6. Your content">
            <p>
              You retain ownership of the content you add to the Service
              (creator lists, notes, brand colors, etc.). You grant us a
              limited license to host, process, and display that content
              solely to provide the Service to you.
            </p>
            <p>
              You are responsible for ensuring you have the necessary rights
              to use any client logos, brand assets, or other materials you
              upload.
            </p>
          </Section>

          <Section title="7. AI-generated output">
            <p>
              Swipe File uses AI models to generate templates, graphics, and
              suggestions. You are responsible for reviewing AI-generated
              output before publishing it. AI output can be inaccurate,
              incomplete, or unintentionally similar to existing material; we
              do not warrant that it is original, accurate, or fit for any
              particular purpose, and we are not liable for content you choose
              to publish.
            </p>
          </Section>

          <Section title="8. Third-party services">
            <p>
              The Service depends on third-party platforms including LinkedIn,
              Anthropic, Apify, Clerk, Supabase, and Vercel. We are not
              responsible for the availability, content, or practices of those
              services. Your use of them is subject to their own terms.
            </p>
          </Section>

          <Section title="9. Termination">
            <p>
              You can stop using the Service at any time by canceling your
              subscription. We may suspend or terminate your access if you
              violate these Terms, if required by law, or if continued
              operation creates an undue risk to the Service.
            </p>
            <p>
              On termination, your access ends and we may delete your
              workspace data after a reasonable period (see our{" "}
              <Link
                href="/privacy"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                Privacy Policy
              </Link>
              ).
            </p>
          </Section>

          <Section title="10. Disclaimers">
            <p>
              The Service is provided &ldquo;as is&rdquo; and &ldquo;as
              available.&rdquo; To the maximum extent permitted by law, we
              disclaim all warranties, express or implied, including
              merchantability, fitness for a particular purpose,
              non-infringement, and any warranties arising from course of
              dealing or trade usage.
            </p>
            <p>
              We do not guarantee that the Service will be uninterrupted,
              error-free, or that any data will be available, accurate, or
              preserved.
            </p>
          </Section>

          <Section title="11. Limitation of liability">
            <p>
              To the maximum extent permitted by law, neither party will be
              liable for indirect, incidental, special, consequential, or
              punitive damages, or for lost profits, revenue, or data. Our
              total liability arising out of or relating to these Terms or the
              Service will not exceed the amount you paid us in the 12 months
              before the event giving rise to the claim, or USD $100,
              whichever is greater.
            </p>
          </Section>

          <Section title="12. Indemnification">
            <p>
              You agree to indemnify and hold us harmless from any claims,
              losses, or expenses arising out of your use of the Service in
              violation of these Terms or applicable law, including claims by
              third parties about content you publish based on Swipe File
              output.
            </p>
          </Section>

          <Section title="13. Changes to the Service or these Terms">
            <p>
              We may modify the Service or these Terms from time to time.
              When we make material changes to these Terms, we will update the
              effective date above and, where appropriate, notify you. If you
              continue to use the Service after changes take effect, you
              accept the updated Terms.
            </p>
          </Section>

          <Section title="14. Governing law and disputes">
            <p>
              These Terms are governed by the laws of Portugal, without regard
              to its conflict-of-laws rules. The courts located in Lisbon,
              Portugal will have exclusive jurisdiction over any dispute
              arising out of or relating to these Terms, except that either
              party may seek injunctive relief in any competent court.
            </p>
          </Section>

          <Section title="15. Contact">
            <p>
              Questions about these Terms: email{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                hello@scalecontentlabs.com
              </a>
              .
            </p>
          </Section>
        </div>
      </section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-medium tracking-tight">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
