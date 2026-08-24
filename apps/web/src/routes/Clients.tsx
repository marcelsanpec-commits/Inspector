import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { EmptyState, ErrorNotice, Modal, Skeletons } from '../components/ui.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface ClientRow {
  clientOrgId: string;
  name: string;
  slug: string;
}

export default function Clients() {
  const { principal } = useAuth();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'add' | 'invite' | null>(null);

  const companyOrgId = useMemo(
    () =>
      principal?.memberships.find(
        (m) =>
          m.orgType === 'inspection_company' &&
          (m.role === 'owner' || m.role === 'admin'),
      )?.orgId,
    [principal],
  );

  const clients = useQuery({
    queryKey: ['clients', companyOrgId],
    enabled: !!companyOrgId,
    queryFn: () =>
      api<{ clients: ClientRow[] }>(`/api/orgs/${companyOrgId}/clients`),
  });

  if (!companyOrgId) {
    return (
      <div className="card">
        <EmptyState title="Company staff only">
          Only an inspecting company keeps a client roster.
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Clients</h1>
          <div className="page-sub">
            Companies you inspect for. Each has its own people and its own sites.
          </div>
        </div>
        <div className="spacer" />
        <div className="inline">
          <button className="btn" onClick={() => setMode('invite')}>
            Invite new client
          </button>
          <button className="btn btn-primary" onClick={() => setMode('add')}>
            Add by account ID
          </button>
        </div>
      </div>

      <ErrorNotice error={clients.error} />
      {clients.isLoading && <Skeletons count={3} />}

      {clients.data &&
        (clients.data.clients.length === 0 ? (
          <div className="card">
            <EmptyState
              title="No clients yet"
              action={
                <button className="btn btn-primary" onClick={() => setMode('invite')}>
                  Invite your first client
                </button>
              }
            >
              Add a client before creating sites or jobs for them.
            </EmptyState>
          </div>
        ) : (
          <div className="card list">
            {clients.data.clients.map((c) => (
              <div className="row" key={c.clientOrgId}>
                <div className="row-main">
                  <div className="row-title">{c.name}</div>
                  <div className="row-meta mono">{c.slug}</div>
                </div>
              </div>
            ))}
          </div>
        ))}

      {mode && (
        <ClientModal
          companyOrgId={companyOrgId}
          mode={mode}
          onClose={() => setMode(null)}
          onDone={() => qc.invalidateQueries({ queryKey: ['clients'] })}
        />
      )}
    </>
  );
}

function ClientModal({
  companyOrgId,
  mode,
  onClose,
  onDone,
}: {
  companyOrgId: string;
  mode: 'add' | 'invite';
  onClose(): void;
  onDone(): void;
}) {
  const [accountId, setAccountId] = useState('');
  const [email, setEmail] = useState('');
  const [organizationName, setOrganizationName] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api(`/api/orgs/${companyOrgId}/clients/by-account-id`, {
        method: 'POST',
        body: { accountId },
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  const invite = useMutation({
    mutationFn: () =>
      api<{ previewLink?: string; emailDelivered: boolean }>(
        `/api/orgs/${companyOrgId}/clients/invite`,
        { method: 'POST', body: { email, organizationName } },
      ),
    onSuccess: onDone,
  });

  const busy = add.isPending || invite.isPending;

  return (
    <Modal
      title={mode === 'add' ? 'Add an existing client' : 'Invite a new client'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || (mode === 'add' ? !accountId.trim() : !email.trim())}
            onClick={() => (mode === 'add' ? add.mutate() : invite.mutate())}
          >
            {busy && <span className="spin" />}
            {mode === 'add' ? 'Add client' : 'Send invitation'}
          </button>
        </>
      }
    >
      <ErrorNotice error={add.error ?? invite.error} />

      {invite.data && (
        <div
          className={`notice ${invite.data.emailDelivered ? 'notice-ok' : 'notice-warn'}`}
        >
          {invite.data.emailDelivered ? (
            'Invitation sent.'
          ) : (
            <>
              <strong>No email provider is configured</strong>, so nothing was
              sent. Send them this link yourself:
              <div className="mono tiny mt" style={{ wordBreak: 'break-all' }}>
                {invite.data.previewLink}
              </div>
            </>
          )}
        </div>
      )}

      {mode === 'add' ? (
        <>
          <p className="small muted mb">
            For a client who already has an InspectorOne account. Adding them
            links their whole organization, so every colleague they add can see
            their delivered work.
          </p>
          <label className="field">
            <span className="label">Their account ID</span>
            <input
              className="input mono"
              autoFocus
              placeholder="IO-7K3M9Q"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value.toUpperCase())}
            />
          </label>
        </>
      ) : (
        <>
          <p className="small muted mb">
            For a client with no account yet. Accepting creates their company,
            makes them its owner, and links it to you in one step.
          </p>
          <label className="field">
            <span className="label">Their company name</span>
            <input
              className="input"
              autoFocus
              placeholder="Harbor Point Properties"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="label">Contact email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        </>
      )}
    </Modal>
  );
}
