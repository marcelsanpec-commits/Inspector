import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { EmptyState, ErrorNotice, Modal, Skeletons } from '../components/ui.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface SiteRow {
  id: string;
  name: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  clientName: string;
  clientOrgId: string;
}

export default function Sites() {
  const { principal } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const companyOrgId = useMemo(
    () =>
      principal?.memberships.find(
        (m) =>
          m.orgType === 'inspection_company' &&
          (m.role === 'owner' || m.role === 'admin'),
      )?.orgId,
    [principal],
  );

  const sites = useQuery({
    queryKey: ['sites'],
    queryFn: () => api<{ sites: SiteRow[] }>('/api/sites'),
  });

  const clients = useQuery({
    queryKey: ['clients', companyOrgId],
    enabled: !!companyOrgId,
    queryFn: () =>
      api<{ clients: { clientOrgId: string; name: string }[] }>(
        `/api/orgs/${companyOrgId}/clients`,
      ),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sites</h1>
          <div className="page-sub">
            Physical locations. Objects live on a site and keep their history
            across every job there.
          </div>
        </div>
        <div className="spacer" />
        {companyOrgId && (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            New site
          </button>
        )}
      </div>

      <ErrorNotice error={sites.error} />
      {sites.isLoading && <Skeletons count={3} />}

      {sites.data &&
        (sites.data.sites.length === 0 ? (
          <div className="card">
            <EmptyState title="No sites yet">
              {companyOrgId
                ? 'Add a site for one of your clients, then create a job there.'
                : 'Sites appear here once work is scheduled at them.'}
            </EmptyState>
          </div>
        ) : (
          <div className="card list">
            {sites.data.sites.map((s) => (
              <div className="row" key={s.id}>
                <div className="row-main">
                  <div className="row-title">{s.name}</div>
                  <div className="row-meta">
                    {s.clientName}
                    {s.addressLine1 ? ` · ${s.addressLine1}` : ''}
                    {s.city ? `, ${s.city}` : ''}
                    {s.state ? ` ${s.state}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}

      {adding && companyOrgId && (
        <NewSiteModal
          clients={clients.data?.clients ?? []}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            qc.invalidateQueries({ queryKey: ['sites'] });
          }}
        />
      )}
    </>
  );
}

function NewSiteModal({
  clients,
  onClose,
  onDone,
}: {
  clients: { clientOrgId: string; name: string }[];
  onClose(): void;
  onDone(): void;
}) {
  const [clientOrgId, setClientOrgId] = useState('');
  const [name, setName] = useState('');
  const [addressLine1, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api('/api/sites', {
        method: 'POST',
        body: {
          clientOrgId,
          name,
          addressLine1: addressLine1 || undefined,
          city: city || undefined,
          state: state || undefined,
        },
      }),
    onSuccess: onDone,
  });

  return (
    <Modal
      title="New site"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={create.isPending || !clientOrgId || !name.trim()}
            onClick={() => create.mutate()}
          >
            {create.isPending && <span className="spin" />}
            Create site
          </button>
        </>
      }
    >
      <ErrorNotice error={create.error} />
      {clients.length === 0 && (
        <div className="notice notice-warn">
          Add a client first — a site always belongs to one.
        </div>
      )}
      <label className="field">
        <span className="label">Client</span>
        <select
          className="select"
          value={clientOrgId}
          onChange={(e) => setClientOrgId(e.target.value)}
        >
          <option value="">Choose a client…</option>
          {clients.map((c) => (
            <option key={c.clientOrgId} value={c.clientOrgId}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="label">Site name</span>
        <input
          className="input"
          placeholder="Harbor Point Tower A"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="label">Address</span>
        <input
          className="input"
          value={addressLine1}
          onChange={(e) => setAddress(e.target.value)}
        />
      </label>
      <div className="grid grid-2">
        <label>
          <span className="label">City</span>
          <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
        </label>
        <label>
          <span className="label">State</span>
          <input
            className="input"
            value={state}
            onChange={(e) => setState(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
