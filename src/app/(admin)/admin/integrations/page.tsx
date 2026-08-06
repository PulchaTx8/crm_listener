import { PageHeader } from '@/components/layout/app-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { logger } from '@/lib/logger';
import { configuredSecrets, listIntegrations } from '@/services/integrations';
import type { IntegrationRow } from '@/services/integrations';
import { IntegrationForm } from './integration-form';

// Renders from the caller's session and a live platform-admin check.
export const dynamic = 'force-dynamic';

/**
 * Block 10a. Who is connected to WhatsApp, and why somebody is not.
 *
 * Until this screen, connecting a radio meant issuing SQL by hand against
 * production: 0057 created `integrations` with RLS and no policies, and nothing
 * in the application ever wrote it.
 */
export default async function IntegrationsPage() {
  const secrets = configuredSecrets();

  let rows: IntegrationRow[];
  try {
    rows = await listIntegrations();
  } catch (cause) {
    logger.error({ err: cause }, 'could not list integrations');
    return (
      <>
        <PageHeader title="WhatsApp integrations" />
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              The integrations could not be loaded.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const allSecretsSet = secrets.appSecret && secrets.verifyToken && secrets.accessToken;

  return (
    <>
      <PageHeader
        title="WhatsApp integrations"
        description="One Meta app serves the whole installation; each Station carries its own number."
      />

      {/*
        THE MOST USEFUL ROW ON THE SCREEN, and the reason it is booleans rather
        than masked values: the question somebody brings here is "why does this
        radio receive no messages", and "the access token is not set" is half
        the answers. A masked value would invite comparing it against something,
        which is where leaking one starts.
      */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Installation credentials</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <SecretLine label="WHATSAPP_APP_SECRET" set={secrets.appSecret} />
          <SecretLine label="WHATSAPP_VERIFY_TOKEN" set={secrets.verifyToken} />
          <SecretLine label="WHATSAPP_ACCESS_TOKEN" set={secrets.accessToken} />
          <p className="mt-2 text-xs text-muted-foreground">
            These are environment variables and are never stored in the database or shown here.
            {allSecretsSet
              ? ' All three are set, so a Station that still receives nothing is a configuration below, not a credential.'
              : ' Until all three are set, no Station sends or receives anything, however it is configured below.'}
          </p>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4">
        {rows.map((row) => (
          <Card key={row.company_id}>
            <CardHeader>
              <CardTitle className="text-base">
                {row.organization_name} · {row.company_name}
                {row.company_status !== 'active' ? (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    {row.company_status}
                  </span>
                ) : null}
                {row.integration_id && !row.enabled ? (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    disabled
                  </span>
                ) : null}
                {!row.integration_id ? (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    not connected
                  </span>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <IntegrationForm row={row} />
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function SecretLine({ label, set }: { label: string; set: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className={
          set
            ? 'inline-block h-2 w-2 rounded-full bg-emerald-500'
            : 'inline-block h-2 w-2 rounded-full bg-destructive'
        }
        aria-hidden
      />
      <code className="text-xs">{label}</code>
      <span className="text-muted-foreground">{set ? 'configured' : 'not set'}</span>
    </span>
  );
}
