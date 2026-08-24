import { useState } from 'react';
import { roleLabel } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';

export default function Account() {
  const { principal } = useAuth();
  const [copied, setCopied] = useState(false);
  if (!principal) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(principal!.accountId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked - the ID is on screen to read anyway */
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account</h1>
          <div className="page-sub">{principal.email}</div>
        </div>
      </div>

      <div className="card card-pad mb">
        <h2>Your account ID</h2>
        <p className="small muted mt" style={{ marginBottom: 12 }}>
          This is how an inspecting company adds you to their team. Read it out
          or paste it to them — it contains no letters or digits that are easy to
          confuse.
        </p>
        <div className="inline">
          <code
            className="mono"
            style={{
              fontSize: '1.5rem',
              fontWeight: 650,
              letterSpacing: '0.06em',
              padding: '10px 16px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
            }}
          >
            {principal.accountId}
          </code>
          <button className="btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="card card-pad">
        <h2 className="mb">Organizations</h2>
        {principal.memberships.length === 0 ? (
          <p className="small muted">
            You're not part of any organization yet. Once a company adds your
            account ID, it will appear here.
          </p>
        ) : (
          <div className="stack">
            {principal.memberships.map((m) => (
              <div className="between" key={m.orgId}>
                <div>
                  <div className="strong">{m.orgName}</div>
                  <div className="tiny dim">
                    {m.orgType === 'inspection_company'
                      ? 'Inspecting company'
                      : 'Client company'}
                  </div>
                </div>
                <span className="pill">{roleLabel(m.role)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
