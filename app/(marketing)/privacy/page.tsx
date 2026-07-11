import Link from "next/link";

export const metadata = {
  title: "Privacy Policy · Swipe File",
  description:
    "How Swipe File collects, uses, and protects your information.",
};

const EFFECTIVE_DATE = "July 1, 2026";

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
              &ldquo;us&rdquo;) is operated by Scale Content Labs, a business
              established in Portugal. For the purposes of the EU General Data
              Protection Regulation (GDPR), we act as the{" "}
              <strong>data controller</strong> for the personal data described
              in this policy. This policy explains what we collect when you use
              our website and product, why we collect it, the legal bases on
              which we rely, and your rights.
            </p>
            <p>
              Questions about this policy, or to exercise your rights, contact
              us at{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
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
                className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
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
                Generate post drafts, templates, graphics, and AI chat
                responses. To do this, the text you send to the AI features
                (your prompts, drafts, tracked-post content, and brand notes) is
                transmitted to third-party AI providers on our behalf via an AI
                gateway (see &ldquo;AI processing&rdquo; and
                &ldquo;Subprocessors&rdquo; below).
              </li>
              <li>Send you account, security, and support emails.</li>
              <li>Debug issues and improve product reliability.</li>
              <li>Comply with legal obligations.</li>
            </ul>
            <p>
              We do not sell your information, and we do not share it with
              third parties for their own marketing. We do not use your
              workspace content to train AI models, and — as described below —
              we instruct our AI providers not to use it to train theirs.
            </p>
          </Section>

          <Section title="6. Subprocessors">
            <p>
              We rely on a small set of vendors to operate the service. Each
              processes data on our behalf under their own privacy commitments
              and data-processing terms:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Vercel</strong> (United States): application hosting.
              </li>
              <li>
                <strong>Supabase</strong> (European Union): database and file
                storage.
              </li>
              <li>
                <strong>Clerk</strong> (United States): authentication and
                account management.
              </li>
              <li>
                <strong>OpenRouter</strong> (United States): the AI gateway that
                routes your AI requests to the underlying model providers below.
              </li>
              <li>
                <strong>Anthropic</strong> (United States): AI model provider
                (Claude models), used for AI chat, drafting, and lead-magnet
                detection.
              </li>
              <li>
                <strong>Zhipu AI / Z.ai</strong> (China): AI model provider
                (GLM models), used for AI chat and drafting. See &ldquo;AI
                processing&rdquo; below for what this means for international
                data transfers.
              </li>
              <li>
                <strong>Apify</strong> (European Union / United States): public
                LinkedIn post scraping.
              </li>
            </ul>
            <p className="text-sm text-muted-foreground">
              We may change subprocessors as the product evolves. When we add or
              replace one in a way that materially affects your data, we will
              update this list and the effective date above.
            </p>
          </Section>

          <Section title="7. AI processing">
            <p>
              Swipe File&rsquo;s drafting, templating, and chat features are
              powered by third-party large language models. When you use these
              features, the content you provide to them — your prompts, drafts,
              the tracked-post text they work from, and any brand notes you
              include — is sent through our AI gateway,{" "}
              <strong>OpenRouter</strong>, which forwards it to the model that
              handles your request. Depending on the request, that model is
              provided by <strong>Anthropic</strong> (in the United States) or{" "}
              <strong>Zhipu AI / Z.ai</strong> (in China).
            </p>
            <p>
              <strong>International transfers.</strong> This means some of the
              content you submit to the AI features may be transferred to and
              processed in the United States and in China, which are outside the
              European Economic Area. Where we transfer personal data outside the
              EEA, we rely on appropriate safeguards permitted under the GDPR
              (such as the European Commission&rsquo;s Standard Contractual
              Clauses) and/or your explicit consent to the transfer, given when
              you choose to use the AI features. You can use the rest of the app
              without using the AI features.
            </p>
            <p>
              <strong>No training on your content.</strong> We do not use your
              content to train our own models, and we configure our AI providers
              so that content routed through the gateway is not used to train
              their models. AI providers may retain request data transiently for
              operational, security, and abuse-prevention purposes under their
              own terms.
            </p>
            <p>
              AI output can be inaccurate or unintentionally similar to existing
              material. You are responsible for reviewing anything the AI
              produces before you publish it (see our{" "}
              <Link
                href="/terms"
                className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
              >
                Terms of Service
              </Link>
              ).
            </p>
          </Section>

          <Section title="8. Where data is stored">
            <p>
              Your account and workspace data is stored on infrastructure
              operated by the subprocessors above, primarily in the European
              Union and the United States. As described in &ldquo;AI
              processing&rdquo; above, content you submit to the AI features may
              additionally be processed in China. By using Swipe File — and, for
              the AI features specifically, by choosing to use them — you consent
              to this storage and processing, subject to the safeguards described
              in this policy.
            </p>
          </Section>

          <Section title="9. Legal bases for processing (GDPR)">
            <p>
              If you are in the European Economic Area, we process your personal
              data on the following legal bases under Article 6 of the GDPR:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                <strong>Performance of a contract</strong> — to create your
                account and provide the Service you signed up for, including the
                core drafting, templating, and chat features.
              </li>
              <li>
                <strong>Consent</strong> — for use of the AI features that send
                your content to third-party AI providers (including the
                international transfers described in &ldquo;AI processing&rdquo;).
                You can decline by not using those features, and you can withdraw
                consent at any time by ceasing to use them.
              </li>
              <li>
                <strong>Legitimate interests</strong> — to secure, debug, and
                improve the Service, prevent abuse, and aggregate publicly
                available LinkedIn posts you choose to track, provided those
                interests are not overridden by your rights.
              </li>
              <li>
                <strong>Legal obligation</strong> — to comply with tax,
                accounting, and other legal requirements.
              </li>
            </ul>
          </Section>

          <Section title="10. How long we keep it">
            <p>
              We retain workspace data for as long as your account is active.
              You can request deletion at any time by emailing{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
              >
                hello@scalecontentlabs.com
              </a>
              . We delete account data within 30 days of a verified request,
              except where we are required to keep records for legal or
              accounting purposes.
            </p>
          </Section>

          <Section title="11. Your rights">
            <p>
              If you are in the European Economic Area, you have the following
              rights under the GDPR in relation to your personal data:
            </p>
            <ul className="list-disc space-y-2 pl-5">
              <li>access the personal data we hold about you;</li>
              <li>rectify inaccurate or incomplete data;</li>
              <li>
                erase your data (&ldquo;right to be forgotten&rdquo;) where the
                conditions apply;
              </li>
              <li>restrict or object to certain processing;</li>
              <li>
                data portability — receive your data in a structured,
                machine-readable format;
              </li>
              <li>
                withdraw consent at any time, without affecting processing
                already carried out.
              </li>
            </ul>
            <p>
              To exercise any of these rights, email{" "}
              <a
                href="mailto:hello@scalecontentlabs.com"
                className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
              >
                hello@scalecontentlabs.com
              </a>
              . We will respond within the time required by the GDPR (generally
              one month). If you believe we have not handled your data lawfully,
              you have the right to lodge a complaint with a supervisory
              authority — in Portugal, the Comissão Nacional de Proteção de
              Dados (CNPD, www.cnpd.pt), or the authority in your country of
              residence.
            </p>
          </Section>

          <Section title="12. Security">
            <p>
              We use encrypted connections (TLS) in transit and at rest where
              supported by our subprocessors. Access to production data is
              limited to a small number of authorized personnel. No system is
              perfectly secure; if we become aware of a breach affecting your
              personal data, we will notify you and the competent supervisory
              authority as required by the GDPR.
            </p>
          </Section>

          <Section title="13. Children">
            <p>
              Swipe File is not directed to children under 16 and we do not
              knowingly collect their personal information.
            </p>
          </Section>

          <Section title="14. Governing law">
            <p>
              This Privacy Policy, and any dispute relating to it or to our
              processing of your personal data, is governed by the laws of
              Portugal and the GDPR as applicable in Portugal, without prejudice
              to any mandatory data-protection rights you have under the law of
              your country of residence.
            </p>
          </Section>

          <Section title="15. Changes to this policy">
            <p>
              We may update this policy from time to time. When we make
              material changes, we will update the effective date above and,
              where appropriate, notify you by email.
            </p>
          </Section>

          <p className="border-t border-[rgba(28,28,26,0.12)] pt-6 text-sm text-muted-foreground">
            Questions? Email{" "}
            <a
              href="mailto:hello@scalecontentlabs.com"
              className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
            >
              hello@scalecontentlabs.com
            </a>
            . See also our{" "}
            <Link
              href="/terms"
              className="underline decoration-[#1C1C1A]/30 hover:decoration-[#1C1C1A]"
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
