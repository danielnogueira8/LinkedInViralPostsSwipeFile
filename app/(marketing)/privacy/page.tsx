import Link from "next/link";

export const metadata = {
  title: "Privacy Policy · Swipe File",
  description:
    "How Swipe File collects, uses, and protects your information.",
};

const EFFECTIVE_DATE = "May 21, 2026";

export default function PrivacyPage() {
  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[300px] bg-gradient-to-b from-accent/30 to-transparent"
      />

      <section className="mx-auto max-w-3xl px-6 pt-20 pb-20 md:pt-28">
        <h1 className="font-display text-4xl leading-[1.1] tracking-tight md:text-5xl">
          Privacy Policy
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Effective {EFFECTIVE_DATE}
        </p>

        <div className="mt-10 space-y-8 text-[15px] leading-relaxed text-black">
          <Section title="1. Who we are">
            <p>
              Swipe File (&ldquo;Swipe File,&rdquo; &ldquo;we,&rdquo;
              &ldquo;us&rdquo;) is operated by Scale Content Labs. This policy
              explains what we collect when you use our website and product,
              why we collect it, and your choices.
            </p>
            <p>
              Questions about this policy: contact us at{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                hello@scalecontentlabs.com
              </a>
              .
            </p>
          </Section>

          <Section title="2. Information you give us">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Account information.</strong> When you sign up we
                receive your name, email, and any profile data you provide
                through our authentication provider (Clerk). We do not see or
                store your password.
              </li>
              <li>
                <strong>Workspace content.</strong> Lists of LinkedIn creators
                you choose to track, niches, brand colors, client names, and
                any notes or settings you add to the app.
              </li>
              <li>
                <strong>Support communication.</strong> If you email us, we
                keep the message so we can respond and improve the product.
              </li>
            </ul>
          </Section>

          <Section title="3. Information we collect automatically">
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Usage logs.</strong> Standard server logs (IP address,
                browser, page requests, timestamps) for security and debugging.
              </li>
              <li>
                <strong>Cookies.</strong> We use cookies that are strictly
                necessary to keep you signed in. We do not use third-party
                advertising or analytics cookies.
              </li>
            </ul>
          </Section>

          <Section title="4. Public LinkedIn data">
            <p>
              Swipe File aggregates public posts from LinkedIn creators that
              you choose to track. We do not log into LinkedIn on your behalf
              and we do not collect data from private accounts or private
              posts. The posts we display are already publicly visible on
              LinkedIn.
            </p>
            <p>
              If you are a LinkedIn creator and want your public posts excluded
              from Swipe File, email{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                hello@scalecontentlabs.com
              </a>{" "}
              and we will remove your profile within 30 days.
            </p>
          </Section>

          <Section title="5. How we use information">
            <ul className="list-disc space-y-2 pl-5">
              <li>Provide and operate the Swipe File product.</li>
              <li>
                Generate post templates and brand-recolored graphics using
                AI models (see &ldquo;Subprocessors&rdquo; below).
              </li>
              <li>Send you account, security, and support emails.</li>
              <li>Debug issues and improve product reliability.</li>
              <li>Comply with legal obligations.</li>
            </ul>
            <p>
              We do not sell your information. We do not use your workspace
              content to train AI models.
            </p>
          </Section>

          <Section title="6. Subprocessors">
            <p>
              We rely on a small set of vendors to operate the service. Each
              processes data on our behalf under their own privacy commitments:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Vercel</strong>: application hosting.
              </li>
              <li>
                <strong>Supabase</strong>: database and file storage.
              </li>
              <li>
                <strong>Clerk</strong>: authentication and account management.
              </li>
              <li>
                <strong>Anthropic</strong>: AI inference for templating and
                lead-magnet detection. Workspace content sent to Anthropic is
                not used to train their models.
              </li>
              <li>
                <strong>Apify</strong>: public LinkedIn post scraping.
              </li>
            </ul>
          </Section>

          <Section title="7. Where data is stored">
            <p>
              Data is stored on infrastructure operated by the subprocessors
              above, primarily in the United States and the European Union.
              By using Swipe File you consent to this storage and processing.
            </p>
          </Section>

          <Section title="8. How long we keep it">
            <p>
              We retain workspace data for as long as your account is active.
              You can request deletion at any time by emailing{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
              >
                hello@scalecontentlabs.com
              </a>
              . We delete account data within 30 days of a verified request,
              except where we are required to keep records for legal or
              accounting purposes.
            </p>
          </Section>

          <Section title="9. Your rights">
            <p>
              Depending on where you live, you may have the right to access,
              correct, export, or delete the personal information we hold
              about you, and to object to or restrict certain processing. To
              exercise any of these rights, email us. We will respond within
              the time required by applicable law.
            </p>
            <p>
              If you are in the EEA, UK, or Switzerland: you can also lodge a
              complaint with your local data protection authority.
            </p>
          </Section>

          <Section title="10. Security">
            <p>
              We use encrypted connections (TLS) in transit and at rest where
              supported by our subprocessors. Access to production data is
              limited to a small number of authorized personnel. No system is
              perfectly secure; if we become aware of a breach affecting your
              data, we will notify you as required by law.
            </p>
          </Section>

          <Section title="11. Children">
            <p>
              Swipe File is not directed to children under 16 and we do not
              knowingly collect their personal information.
            </p>
          </Section>

          <Section title="12. Changes to this policy">
            <p>
              We may update this policy from time to time. When we make
              material changes, we will update the effective date above and,
              where appropriate, notify you by email.
            </p>
          </Section>

          <p className="border-t border-[rgba(55,50,47,0.12)] pt-6 text-sm text-muted-foreground">
            Questions? Email{" "}
            <a
              href="mailto:hello@scalecontentlabs.com"
              className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
            >
              hello@scalecontentlabs.com
            </a>
            . See also our{" "}
            <Link
              href="/terms"
              className="underline decoration-[#37322F]/30 hover:decoration-[#37322F]"
            >
              Terms of Service
            </Link>
            .
          </p>
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
