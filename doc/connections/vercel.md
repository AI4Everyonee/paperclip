# Vercel deployment connection

Reviewed 2026-10-22 against Vercel's [REST reference](https://vercel.com/docs/rest-api)
and [official OpenAPI contract](https://openapi.vercel.sh).

The Vercel app gives agents governed deployment and project configuration tools
through a team-scoped access token. This is a Vercel resource connection; the
separate [Vercel Connect](VERCEL-CONNECT.md) feature brokers credentials for other
providers and does not supply this connection's token.

## Transport and authentication

| Axis | Selection |
| --- | --- |
| Method | `rest-api-key` |
| Transport | Reviewed `rest_api` adapter, delivered by the normal run-scoped tool gateway |
| API origin | `https://api.vercel.com` with fixed versioned routes |
| Credential | Vercel access token, sent only as `Authorization: Bearer …` |
| Ownership | Customer credential in the Paperclip vault; personal grants keep user-owned secret references |
| Resource scope | Required `teamId`; targeted project actions verify the returned project's `accountId`, and deployment actions verify `projectId` |
| Permission | Provider team/token role plus Paperclip agent access and individual action policy |

Vercel's token team selection, expiration and the account's permissions determine
provider access. Paperclip cannot expand an issued token. See
[REST authentication](https://vercel.com/docs/rest-api#authentication).
The key must support project reads and the desired deployment/configuration writes.
No OAuth scopes are requested for this method. Reconnect with a fresh token when
it expires, is revoked, or lacks access.

## Why use the REST adapter

Vercel's official [MCP reference](https://vercel.com/docs/agent-resources/vercel-mcp/tools)
now includes deployment and configuration tools, but explicitly says availability
and approval can differ by client. Paperclip's earlier MCP entry was unavailable
pending client approval. Public metadata demonstrates OAuth protocol support; it
does not prove Paperclip client acceptance or account-bound writes. The reviewed
REST adapter provides a self-serve token path without assuming MCP client approval.
The historical MCP method is not advertised as a second setup choice.

Public preflight on 2026-10-22, without registering a client or signing in:

| Observation | Result |
| --- | --- |
| Endpoint | `https://mcp.vercel.com` |
| Unauthenticated GET | HTTP 401; Bearer `invalid_token` challenge |
| Protected resource metadata | `https://mcp.vercel.com/.well-known/oauth-protected-resource` |
| Resource | `https://mcp.vercel.com/` |
| Authorization server metadata | `https://mcp.vercel.com/.well-known/oauth-authorization-server` |
| Issuer / authorization | `https://vercel.com` / `https://vercel.com/oauth/authorize` |
| Token / revocation | `https://vercel.com/api/login/oauth/token` / `https://vercel.com/api/login/oauth/token/revoke` |
| Registration | `https://vercel.com/api/login/oauth/register` advertised; not called |
| PKCE / token authentication | S256 / `none` |
| Protected-resource scopes | `openid` |
| Authorization-server advertised scopes | `openid`, `email`, `offline_access`, `profile`; not automatically requested |

These observations are public protocol evidence only. MCP transport negotiation,
client approval, redirects, consent, token lifetime and account entitlements were
not qualified by this preflight.

## Connection flow

1. In Apps, choose **Vercel → Connect Vercel**.
2. Enter an access token from [Vercel account tokens](https://vercel.com/account/tokens).
3. Enter the Team ID from Vercel Team Settings → General. The token must have
   access to this team. Agents cannot override the team in tool arguments.
4. Finish setup. Discovery performs a safe team read before publishing the
   reviewed catalog. A failed credential or team read fails setup visibly.
5. Use the regular Permissions page to select agents and allowed actions. Existing
   action restrictions remain authoritative on refresh or reconnect.

The existing connection setup, credential writer, grant resolver, policies,
approval flow and audit own this lifecycle. The provider adapter receives resolved
headers and makes bounded requests; it never reads local CLI credentials or
exports a provider token to an agent.

## Administrator setup

No Vercel OAuth application registration is needed for the access-token method.
Use an account and team where deployments are authorized and select that team
when creating the token. Vercel plan limits, role restrictions, repository access
and usage billing still apply. GitHub deployments need the repository available
to Vercel; this connector does not install or authorize Vercel's GitHub integration.

To revoke, delete the token in Vercel account settings and remove the connection
in Paperclip. A retained Paperclip grant cannot make a revoked token usable.
Replacing the token through reconnect preserves connection identity and explicit
action policies. The normal removal path revokes access and cleans credential refs.

## Reviewed actions

All names below have the `vercel_` prefix.

| Capability | Actions | Risk |
| --- | --- | --- |
| Project inventory | `list_projects`, `get_project` | Read |
| Project build configuration | `create_project`, `update_project` | Write |
| Deployment inventory/status | `list_deployments`, `get_deployment` | Read |
| Deploy | `create_deployment` | Write |
| Environment metadata | `list_environment_variables` | Read |
| Set environment variables | `upsert_environment_variable` | Write |
| Domain inventory | `list_domains` | Read |
| Attach/verify owned domains | `add_domain`, `verify_domain` | Write |
| Cleanup and interruption | `delete_project`, `delete_deployment`, `cancel_deployment`, `delete_environment_variable`, `remove_domain` | Destructive |

Unknown tool names fail closed. Changed catalog schemas or risks require refresh
and review through the shared catalog contract. The adapter does not expose a
generic HTTP operation, token management, billing purchases, DNS administration,
domain registration or project transfers.

For a deployment, first select or create a project, optionally set environment
variables and build settings, then call `create_deployment` with exactly one of:

- Inline `files: [{file, content, encoding?}]`. Paths must be unique and relative;
  aggregate request size is limited to 4 MiB. No server filesystem path is read.
- `gitSource: {type: "github", repoId, ref}` for larger repositories.
- `deploymentId` to redeploy an existing deployment in that same project.

Preview is the default target; `target: "production"` must be explicit. The
adapter submits one deployment request and returns its ID, URL and state. A
`QUEUED` or `BUILDING` response is not success evidence: inspect with
`get_deployment` until a terminal state is observed. Provider mutations are never
retried automatically after a timeout or ambiguous transport failure.

Configuration includes framework, build/install/dev commands, root/output
directories and Node version. Deployment settings fall back to the selected
project's current settings, including for a first deployment. Other provider
settings remain available in Vercel's dashboard.

Environment writes use `secretValue`, a redacted audit field, and explicit
`target` values (`preview`, `production`, `development`). They default to encrypted
provider storage. `sensitive` supports preview/production only. Metadata reads set
`decrypt=false`; responses omit values, ciphertext and internal credential hints.
Vercel's HTTP-200 response can contain failed writes; those are surfaced as failure.
Changed environment variables apply to subsequent deployments.

## Validation and remaining proof

Acceptance criteria: actionable setup; vaulted token; 17 reviewed tools; safe
team/project reads; a policy-governed preview deployment and configuration write;
cross-company, foreign-team and foreign-project rejection; reconnect and removal;
and no token or environment value in responses/audit.

Provider unit coverage lives in
`server/src/services/connectors/vercel/index.test.ts`. It covers fixed routes,
strict schemas, ownership checks before writes, preview/production payloads,
GitHub deployment, secret projection, environment partial failure, catalogue
drift, and cancellation of a stalled prerequisite without a late mutation.
The database-backed lifecycle suite is
`server/src/__tests__/deployment-connections.test.ts`.

Account-bound live proof passed on 2026-10-22 with an approved, one-hour token
and disposable projects in an isolated local Paperclip instance. Actual process
agent runs used the run-scoped gateway to list projects, create a project, write
a synthetic preview environment secret, read back metadata without its value,
and create a preview deployment that reached `READY`. The signed-in browser
loaded the deployed page and showed the exact synthetic marker. Anonymous access
returned 302 under the team's existing deployment protection, which was retained.
Gateway cleanup deleted both disposable projects and confirmed their absence.
The temporary provider token and local connection were removed. A fresh process
agent received no Vercel tools, and calling the prior tool name returned 404.

This proves the token method's preview deployment and environment configuration
path for this account. Production publishing, GitHub-source deployment, custom
domains, forced credential refresh, and all provider plan combinations were not
live-tested. Their fixture coverage does not establish account entitlement.
Keep receipts free of credentials, environment values, and raw provider errors.

Sensitive tool arguments such as `secretValue` are encrypted in newly created
approval payloads with the instance tool-action signing secret. Approval summaries
and audit still use redacted values. Existing signed approval records remain
readable and are not rewritten. Sensitive request identities also use this key
to distinguish secret replacements without storing guessable secret hashes.
Key rotation can invalidate retry matching; back up the signing key with the database.
