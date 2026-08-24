import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorNotice } from '../components/ui.js';
import { api } from '../lib/api.js';

interface ClientRow {
  clientOrgId: string;
  name: string;
}
interface SiteRow {
  id: string;
  name: string;
  city: string | null;
  clientOrgId: string;
}
interface InspectorRow {
  userId: string;
  name: string;
  role: string;
}

export default function JobNew() {
  const navigate = useNavigate();

  const [clientOrgId, setClientOrgId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [title, setTitle] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [notes, setNotes] = useState('');
  const [inspectorIds, setInspectorIds] = useState<string[]>([]);
  const [restricted, setRestricted] = useState(false);

  const orgs = useQuery({
    queryKey: ['my-orgs'],
    queryFn: () =>
      api<{ organizations: { orgId: string; orgType: string; role: string }[] }>(
        '/api/orgs',
      ),
  });

  const companyOrgId = useMemo(
    () =>
      orgs.data?.organizations.find(
        (o) =>
          o.orgType === 'inspection_company' &&
          (o.role === 'owner' || o.role === 'admin'),
      )?.orgId,
    [orgs.data],
  );

  const clients = useQuery({
    queryKey: ['clients', companyOrgId],
    enabled: !!companyOrgId,
    queryFn: () =>
      api<{ clients: ClientRow[] }>(`/api/orgs/${companyOrgId}/clients`),
  });

  const sites = useQuery({
    queryKey: ['sites'],
    queryFn: () => api<{ sites: SiteRow[] }>('/api/sites'),
  });

  const inspectors = useQuery({
    queryKey: ['inspectors'],
    queryFn: () => api<{ inspectors: InspectorRow[] }>('/api/inspectors'),
  });

  // Only sites belonging to the chosen client can host its job.
  const availableSites = (sites.data?.sites ?? []).filter(
    (s) => !clientOrgId || s.clientOrgId === clientOrgId,
  );

  const create = useMutation({
    mutationFn: () =>
      api<{ job: { id: string } }>('/api/jobs', {
        method: 'POST',
        body: {
          clientOrgId,
          siteId,
          title,
          scheduledFor: scheduledFor || null,
          notes: notes || undefined,
          inspectorIds,
          clientAccess: restricted ? 'restricted' : 'org_wide',
          clientViewerIds: [],
        },
      }),
    onSuccess: (res) => navigate(`/jobs/${res.job.id}`, { replace: true }),
  });

  const noClients = clients.data && clients.data.clients.length === 0;
  const noSites = !!clientOrgId && availableSites.length === 0;

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/jobs" className="small muted">
            ← Jobs
          </Link>
          <h1 style={{ marginTop: 6 }}>New job</h1>
        </div>
      </div>

      <div className="card card-pad" style={{ maxWidth: 640 }}>
        <ErrorNotice error={create.error} />

        {noClients && (
          <div className="notice notice-warn">
            You have no clients yet. <Link to="/clients">Add a client</Link> before
            creating a job.
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="field">
            <span className="label">Client</span>
            <select
              className="select"
              required
              value={clientOrgId}
              onChange={(e) => {
                setClientOrgId(e.target.value);
                setSiteId('');
              }}
            >
              <option value="">Choose a client…</option>
              {(clients.data?.clients ?? []).map((c) => (
                <option key={c.clientOrgId} value={c.clientOrgId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="label">Site</span>
            <select
              className="select"
              required
              disabled={!clientOrgId}
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
            >
              <option value="">
                {clientOrgId ? 'Choose a site…' : 'Choose a client first'}
              </option>
              {availableSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.city ? ` — ${s.city}` : ''}
                </option>
              ))}
            </select>
            {noSites && (
              <span className="hint">
                That client has no sites yet. <Link to="/sites">Add one</Link>.
              </span>
            )}
          </label>

          <label className="field">
            <span className="label">Title</span>
            <input
              className="input"
              required
              placeholder="Annual structural inspection"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="label">Scheduled for</span>
            <input
              className="input"
              type="date"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
            />
          </label>

          <div className="field">
            <span className="label">Inspectors</span>
            {(inspectors.data?.inspectors ?? []).length === 0 ? (
              <p className="small muted">
                No inspectors on your team yet. <Link to="/team">Add one</Link>.
              </p>
            ) : (
              (inspectors.data?.inspectors ?? []).map((i) => (
                <label className="check" key={i.userId}>
                  <input
                    type="checkbox"
                    checked={inspectorIds.includes(i.userId)}
                    onChange={(e) =>
                      setInspectorIds((prev) =>
                        e.target.checked
                          ? [...prev, i.userId]
                          : prev.filter((x) => x !== i.userId),
                      )
                    }
                  />
                  <span>
                    {i.name} <span className="dim tiny">({i.role})</span>
                  </span>
                </label>
              ))
            )}
            <span className="hint">
              Inspectors see only the jobs they are assigned to.
            </span>
          </div>

          <label className="field">
            <span className="label">Notes</span>
            <textarea
              className="textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={restricted}
              onChange={(e) => setRestricted(e.target.checked)}
            />
            <span>
              <span className="strong">Restrict client access</span>
              <span className="segment-desc">
                By default everyone at the client company sees this job once
                delivered. Restricting it limits visibility to people you name
                afterwards.
              </span>
            </span>
          </label>

          <button
            className="btn btn-primary btn-lg btn-block mt"
            disabled={create.isPending || !!noClients}
          >
            {create.isPending && <span className="spin" />}
            Create job
          </button>
        </form>
      </div>
    </>
  );
}
