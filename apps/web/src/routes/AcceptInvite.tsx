import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ErrorNotice,
  Loading,
  PasswordInput,
  roleLabel,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface InvitePreview {
  invite: {
    email: string;
    role: string;
    invitedBy: string;
    orgType: string;
    newClientOrgName: string | null;
    expiresAt: string;
  };
  /** Whether this email already has an account, so we know what to ask for. */
  accountExists: boolean;
}

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const preview = useQuery({
    queryKey: ['invite', token],
    enabled: !!token,
    retry: false,
    queryFn: () =>
      api<InvitePreview>(`/api/auth/invite?token=${encodeURIComponent(token)}`),
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await acceptInvite({
        token,
        ...(preview.data?.accountExists ? {} : { name, password }),
      });
      navigate('/jobs', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-wrap">
        <div className="auth-card card card-pad">
          <div className="notice notice-error">
            This invitation link is missing its token. Ask whoever invited you to
            send it again.
          </div>
          <Link className="btn btn-block" to="/login">
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="brand">
            <span className="brand-mark">IO</span>
            InspectorOne
          </div>
        </div>

        <div className="card card-pad">
          {preview.isLoading && <Loading label="Checking your invitation" />}

          {preview.isError && (
            <>
              <ErrorNotice error={preview.error} />
              <Link className="btn btn-block" to="/login">
                Go to sign in
              </Link>
            </>
          )}

          {preview.data && (
            <form onSubmit={submit}>
              <ErrorNotice error={error} />

              <div className="notice notice-info">
                <strong>{preview.data.invite.invitedBy}</strong> invited you to
                join
                {preview.data.invite.newClientOrgName ? (
                  <>
                    {' '}
                    as owner of{' '}
                    <strong>{preview.data.invite.newClientOrgName}</strong>
                  </>
                ) : (
                  <> as {roleLabel(preview.data.invite.role)}</>
                )}
                .
              </div>

              <label className="field">
                <span className="label">Email</span>
                <input
                  className="input"
                  value={preview.data.invite.email}
                  disabled
                />
                <span className="hint">
                  The invitation is tied to this address.
                </span>
              </label>

              {preview.data.accountExists ? (
                <p className="muted small mb">
                  You already have an InspectorOne account with this email.
                  Accepting will add this organization to it.
                </p>
              ) : (
                <>
                  <label className="field">
                    <span className="label">Your name</span>
                    <input
                      className="input"
                      required
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <div className="field">
                    <span className="label">Choose a password</span>
                    <PasswordInput
                      value={password}
                      onChange={setPassword}
                      autoComplete="new-password"
                      minLength={10}
                      required
                    />
                    <span className="hint">At least 10 characters.</span>
                  </div>
                </>
              )}

              <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                {busy && <span className="spin" />}
                Accept invitation
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
