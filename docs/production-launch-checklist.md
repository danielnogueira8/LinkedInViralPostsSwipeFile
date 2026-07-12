# Production launch checklist

## Clerk: Development to Production migration

> **Do not switch the deployed app from Clerk test keys to live keys until this
> migration is complete.** Clerk Development and Production instances have
> separate user and organization data. Creating the Production instance can
> clone configuration, but it does not preserve Development users,
> organizations, or their IDs.

SwipeIn currently uses the Clerk organization ID (`org_...`) as the canonical
`workspace_id` throughout Supabase. A user recreated in Clerk Production will
therefore receive a new user ID and a new organization ID. Switching directly
from `pk_test_` / `sk_test_` to `pk_live_` / `sk_live_` would make an existing
customer appear to have a new, empty workspace while their data remains attached
to the old Development `workspace_id`.

Before enabling Clerk Production:

- [ ] Create and configure the Clerk Production instance and production domain.
- [ ] Recreate or import each existing user into Clerk Production.
- [ ] Create the user's Production organization and membership.
- [ ] Build and verify an explicit mapping of Development IDs to Production IDs:
  - old Clerk user ID -> new Clerk user ID
  - old Clerk organization ID -> new Clerk organization ID
- [ ] Back up the production Supabase database before remapping identifiers.
- [ ] Transactionally replace every old Clerk organization ID used as a
  `workspace_id`, including all workspace-scoped tables and ownership/reference
  columns such as `owner_workspace_id` and `manual_owner_workspace_id`.
- [ ] Remap stored Clerk user IDs such as `created_by_user_id`, contributor IDs,
  invitation recipients, and any other user ownership fields.
- [ ] Run integrity checks to confirm no rows still reference Development user or
  organization IDs and no customer data moved to the wrong workspace.
- [ ] Change the deployed Clerk environment variables to the Production values
  (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...` and
  `CLERK_SECRET_KEY=sk_live_...`) and redeploy.
- [ ] Reconfigure production-only Clerk integrations that are not cloned,
  including OAuth credentials, webhooks and webhook signing secrets, redirect
  URLs, and DNS/certificates.
- [ ] Regenerate every Claude MCP connector URL. The URL construction remains
  `https://tryswipein.com/api/mcp?workspace_id=<production_org_id>`, but the
  `workspace_id` must be the new Production Clerk organization ID.
- [ ] Have existing customers reconnect/re-authorize the SwipeIn MCP connector
  against Clerk Production.
- [ ] Smoke-test sign-in, workspace loading, MCP OAuth, and representative reads
  and writes for every migrated workspace before completing the cutover.
- [ ] Keep a tested rollback plan until the migration and customer verification
  are complete.

References:

- [Clerk environments](https://clerk.com/docs/guides/development/managing-environments)
- [Deploying Clerk to Production](https://clerk.com/docs/guides/development/deployment/production)
- [Clerk migration overview](https://clerk.com/docs/guides/development/migrating/overview)
