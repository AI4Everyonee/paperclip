import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getAppStoreDefinition, type ToolCatalogEntry } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { ConnectionSetupFlow } from "@/features/connections/ConnectionSetupFlow";
import { ConnectorCard } from "@/pages/apps/Browse";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";

const app = getAppStoreDefinition("1password")!;
const companyId = "company-storybook";
const tools = [
  { name: "onepassword_list_vaults", risk: "read", description: "List authorized vaults.", properties: {} },
  { name: "onepassword_create_item", risk: "write", description: "Create a disposable item.", properties: { vaultId: { type: "string" }, title: { type: "string" }, category: { type: "string", enum: ["SecureNote"] } } },
  { name: "onepassword_delete_item", risk: "destructive", description: "Delete a disposable item.", properties: { vaultId: { type: "string" }, itemId: { type: "string" } } },
].map(({ name, risk, description, properties }) => ({ id: name, toolName: name, title: name, description,
  companyId, connectionId: "onepassword-review", status: "active", riskLevel: risk,
  isReadOnly: risk === "read", isWrite: risk === "write", isDestructive: risk === "destructive",
  inputSchema: { type: "object", properties, additionalProperties: false },
}) as unknown as ToolCatalogEntry);

function OnePasswordReview({ screen = "catalog", rejected = false, inline = false }: {
  screen?: "catalog" | "connect" | "permissions"; rejected?: boolean; inline?: boolean;
}) {
  const [step, setStep] = useState(screen);
  const [ready, setReady] = useState(false);
  const [enabledIds, setEnabledIds] = useState(new Set(tools.map(tool => tool.id)));
  const [askFirstIds, setAskFirstIds] = useState(new Set<string>());
  const client = useMemo(() => {
    const result = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    result.setQueryData(queryKeys.apps.gallery(companyId), { apps: [app], capabilities: { canSetCompanyInstall: true } });
    return result;
  }, []);
  useEffect(() => {
    const original = window.fetch;
    const fixture: typeof window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.pathname === `/api/companies/${companyId}/tools/applications`) return Response.json({ applications: [] });
      if (url.pathname === `/api/companies/${companyId}/tools/connections`) return Response.json({ connections: [] });
      if (url.pathname === `/api/companies/${companyId}/tools/apps/connect`) {
        if (rejected) return Response.json({ error: "1Password could not verify access. Check the token and its vault permissions." }, { status: 422 });
        return Response.json({ connectionId: "onepassword-review", application: { id: "onepassword-app", name: app.name },
          connection: { id: "onepassword-review", name: app.name, status: "active" }, catalog: tools,
          actions: { readOnly: tools.filter(tool => tool.isReadOnly), canMakeChanges: tools.filter(tool => !tool.isReadOnly) }, suggestedDefaults: {} });
      }
      if (url.pathname === `/api/companies/${companyId}/tools/apps/onepassword-review/finish`) return Response.json({ connectionId: "onepassword-review", installs: [] });
      if (url.pathname === "/api/tool-connections/onepassword-review/test-calls") return Response.json({ status: "success", result: { content: [{ type: "text", text: '[{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaa","title":"Disposable test vault"}]' }] } });
      if (url.pathname.startsWith("/api/tool-connections/onepassword-review/")) return Response.json({ connectionId: "onepassword-review", installs: [], entries: tools });
      return original(input, init);
    };
    window.fetch = fixture; setReady(true);
    return () => { if (window.fetch === fixture) window.fetch = original; };
  }, [rejected]);
  return <QueryClientProvider client={client}><div className="min-h-screen bg-background text-foreground">
    <p role="note" className="border-b border-border bg-muted p-4 text-sm">Storybook simulation. Use fake credentials. Provider calls and storage are simulated.</p>
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      {step === "catalog" ? <ConnectorCard row={{ key: app.slug, slug: app.slug, name: app.name, description: app.description,
        brandKey: app.slug, logoUrl: app.branding.logoUrl, darkLogoUrl: app.branding.darkLogoUrl, entry: app,
        applications: [], connections: [], chatEndpoints: [] }} userProfileById={new Map()} chatConnectorsEnabled={false}
        onNavigate={() => setStep("connect")} onRequestRemove={() => {}} />
        : step === "connect" && ready ? <ConnectionSetupFlow serviceSlug="1password" host={inline ? "dialog" : "page"}
          onComplete={() => setStep("permissions")} onCancel={() => setStep("catalog")} />
        : step === "permissions" ? <ActionsSection connectionId="onepassword-review" appName={app.name}
          readOnly={tools.filter(tool => tool.isReadOnly)} canChange={tools.filter(tool => !tool.isReadOnly)} quarantined={[]}
          enabledIds={enabledIds} askFirstIds={askFirstIds} disabled={false} refreshPending={false} canConfigure
          onSetPermission={(ids, permission) => {
            setEnabledIds(current => { const next = new Set(current); ids.forEach(id => permission === "off" ? next.delete(id) : next.add(id)); return next; });
            setAskFirstIds(current => { const next = new Set(current); ids.forEach(id => permission === "ask" ? next.add(id) : next.delete(id)); return next; });
          }} onReviewQuarantined={() => {}} onRefreshActions={() => {}} /> : null}
    </div>
  </div></QueryClientProvider>;
}

const meta = { id: "apps-connections-onepassword", title: "Apps, channels, and extensions/Connection setup/Apps/Connections/1Password",
  component: OnePasswordReview, parameters: { layout: "fullscreen", paperclip: { implementation: "production", boundary: "fixtures",
    capabilities: ["connection-setup/catalog", "connection-setup/credentials", "connection-setup/failure", "app-permissions/action-policy", "app-permissions/test-action"],
    notes: "Production catalog card, token setup and Actions/Test controls with synthetic fixtures. No provider proof or task execution is claimed." } },
} satisfies Meta<typeof OnePasswordReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CatalogAndSetup: Story = {};
export const ServiceAccountToken: Story = { args: { screen: "connect" } };
export const RejectedCredentials: Story = { args: { screen: "connect", rejected: true } };
export const PermissionsAndTest: Story = { args: { screen: "permissions" } };
export const InlineTaskSetup: Story = { args: { screen: "connect", inline: true } };
export const NarrowSetup: Story = { args: { screen: "connect" }, globals: { viewport: { value: "mobile1", isRotated: false } } };
