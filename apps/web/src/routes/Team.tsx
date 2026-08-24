import type { MembershipRole, MembershipSummary } from '@inspectorone/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  EmptyState,
  ErrorNotice,
  formatDate,
  Modal,
  roleLabel,
  Skeletons,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface Member {
  userId: string;
  name: string;
  email: string;
  accountId: string;
  role: MembershipRole;
  joinedAt: string;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

/** Roles are constrained by org type - the API rejects mismatches. */
const ROLE_OPTIONS: Record<string, MembershipRole[]> = {
  inspection_company: ['inspector', 'admin', 'owner'],
  client: ['member', 'admin', 'owner'],
};

export default function Team() {
  const { principal, refresh } = useAuth();
  const qc = useQueryClient();

  const manageable = (principal?.memberships ?? []).filter(
    (m) => m.role === 'owner' || m.role === 'admin',
  );
  const [orgId, setOrgId] = useState(manageable[0]?.orgId ?? '');
  const org = manageable.find((m) => m.orgId === orgId) ?? manageable[0];

  const [showAdd, setShowAdd] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  const members = useQuery({
    queryKey: ['members', orgId],
    enabled: !!orgId,
    queryFn: () => api<{ members: Member[] }>(`/api/orgs/${orgId}/members`),
  });

  const invites = useQuery({
    queryKey: ['invites', orgId],
    enabled: !!orgId,
    queryFn: () => api<{ invites: Invite[] }>(`/api/orgs/${orgId}/invites`),
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members', orgId] });
      refresh();
    },
  });

  const changeRole = useMutation({
    mutationFn: (v: { userId: string; role: MembershipRole }) =>
      api(`/api/orgs/${orgId}/members/${v.userId}`, {
        method: 'PATCH',
        body: { role: v.role },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members', orgId] });
      refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (inviteId: string) =>
      api(`/api/orgs/${orgId}/invites/${inviteId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites', orgId] }),
  });

  if (!org) {
    return (
      <div className="card">
        <EmptyState title="Nothing to manage">
          You need to be an owner or admin of an organization to manage its
          people.
        </EmptyState>
      </div>
    );
  }

  const roles = ROLE_OPTIONS[org.orgType] ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <div className="page-sub">People who can sign in to {org.orgName}</div>
        </div>
        <div className="spacer" />
        <div className="inline">
          {manageable.length > 1 && (
            <select
              className="select"
              style={{ width: 'auto' }}
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
            >
              {manageable.map((m: MembershipSummary) => (
                <option key={m.orgId} value={m.orgId}>
                  {m.orgName}
                </option>
              ))}
            </select>
          )}
          <button className="btn" onClick={() => setShowInvite(true)}>
            Invite by email
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            Add by account ID
          </button>
        </div>
      </div>

      <ErrorNotice error={remove.error ?? changeRole.error} />

      {members.isLoading && <Skeletons />}
      {members.data && (
        <div className="card list">
          {members.data.members.map((m) => (
            <div className="row" key={m.userId}>
              <div className="row-main">
                <div className="row-title">
                  {m.name}
                  {m.userId === principal?.userId && (
                    <span className="pill" style={{ marginLeft: 8 }}>
                      you
                    </span>
                  )}
                </div>
                <div className="row-meta">
                  {m.email} · <span className="mono">{m.accountId}</span> · joined{' '}
                  {formatDate(m.joinedAt)}
                </div>
              </div>
              <div className="row-side">
                <select
                  className="select"
                  style={{ width: 'auto', minHeight: 34, fontSize: '0.86rem' }}
                  value={m.role}
                  disabled={changeRole.isPending}
                  onChange={(e) =>
                    changeRole.mutate({
                      userId: m.userId,
                      role: e.target.value as MembershipRole,
                    })
                  }
                >
                  {roles.map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-sm btn-danger"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (confirm(`Remove ${m.name} from ${org.orgName}?`)) {
                      remove.mutate(m.userId);
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!!invites.data?.invites.length && (
        <>
          <h2 className="mt mb">Pending invitations</h2>
          <div className="card list">
            {invites.data.invites.map((i) => (
              <div className="row" key={i.id}>
                <div className="row-main">
                  <div className="row-title">{i.email}</div>
                  <div className="row-meta">
                    {roleLabel(i.role)} · expires {formatDate(i.expiresAt)}
                  </div>
                </div>
                <div className="row-side">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => revoke.mutate(i.id)}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {showAdd && (
        <AddByAccountId
          orgId={orgId}
          roles={roles}
          onClose={() => setShowAdd(false)}
          onDone={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ['members', orgId] });
          }}
        />
      )}

      {showInvite && (
        <InviteByEmail
          orgId={orgId}
          roles={roles}
          onClose={() => setShowInvite(false)}
          onDone={() => qc.invalidateQueries({ queryKey: ['invites', orgId] })}
        />
      )}
    </>
  );
}

function AddByAccountId({
  orgId,
  roles,
  onClose,
  onDone,
}: {
  orgId: string;
  roles: MembershipRole[];
  onClose(): void;
  onDone(): void;
}) {
  const [accountId, setAccountId] = useState('');
  const [role, setRole] = useState<MembershipRole>(roles[0] ?? 'member');

  const add = useMutation({
    mutationFn: () =>
      api(`/api/orgs/${orgId}/members/by-account-id`, {
        method: 'POST',
        body: { accountId, role },
      }),
    onSuccess: onDone,
  });

  return (
    <Modal
      title="Add by account ID"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={add.isPending || !accountId.trim()}
            onClick={() => add.mutate()}
          >
            {add.isPending && <span className="spin" />}
            Add to team
          </button>
        </>
      }
    >
      <ErrorNotice error={add.error} />
      <p className="small muted mb">
        They must already have an InspectorOne account. Ask them for the account
        ID shown at the top of their screen.
      </p>
      <label className="field">
        <span className="label">Account ID</span>
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
      <label className="field">
        <span className="label">Role</span>
        <select
          className="select"
          value={role}
          onChange={(e) => setRole(e.target.value as MembershipRole)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}

function InviteByEmail({
  orgId,
  roles,
  onClose,
  onDone,
}: {
  orgId: string;
  roles: MembershipRole[];
  onClose(): void;
  onDone(): void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>(roles[0] ?? 'member');

  const invite = useMutation({
    mutationFn: () =>
      api<{ previewLink?: string; emailDelivered: boolean }>(
        `/api/orgs/${orgId}/invites`,
        { method: 'POST', body: { email, role } },
      ),
    onSuccess: onDone,
  });

  return (
    <Modal
      title="Invite by email"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn btn-primary"
            disabled={invite.isPending || !email.trim()}
            onClick={() => invite.mutate()}
          >
            {invite.isPending && <span className="spin" />}
            Send invitation
          </button>
        </>
      }
    >
      <ErrorNotice error={invite.error} />

      {invite.data && (
        <div
          className={`notice ${invite.data.emailDelivered ? 'notice-ok' : 'notice-warn'}`}
        >
          {invite.data.emailDelivered ? (
            'Invitation sent.'
          ) : (
            <>
              <strong>No email provider is configured</strong>, so nothing was
              sent. Copy this link to them yourself:
              <div className="mono tiny mt" style={{ wordBreak: 'break-all' }}>
                {invite.data.previewLink}
              </div>
            </>
          )}
        </div>
      )}

      <label className="field">
        <span className="label">Email</span>
        <input
          className="input"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="label">Role</span>
        <select
          className="select"
          value={role}
          onChange={(e) => setRole(e.target.value as MembershipRole)}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}
