import type { SignupRole } from '@inspectorone/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ErrorNotice, PasswordInput } from '../components/ui.js';
import { useAuth } from '../lib/auth.js';

const ROLES: {
  value: SignupRole;
  title: string;
  desc: string;
  orgLabel?: string;
  orgHint?: string;
}[] = [
  {
    value: 'inspection_company',
    title: 'Inspecting company',
    desc: 'You run inspections. Add inspectors and clients, create jobs, and deliver reports.',
    orgLabel: 'Company name',
    orgHint: 'This is the organization your inspectors and clients will be added to.',
  },
  {
    value: 'inspector',
    title: 'Inspector',
    desc: 'You do the field work. After signing up, give your account ID to the company you work for so they can add you.',
  },
  {
    value: 'client',
    title: 'Client',
    desc: 'You receive inspections. View reports and photos for your own sites, and add colleagues who need access.',
    orgLabel: 'Your company name',
    orgHint: 'Colleagues you add later will join this organization.',
  },
];

export default function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();

  const [role, setRole] = useState<SignupRole | null>(null);
  const [name, setName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const chosen = ROLES.find((r) => r.value === role);
  const needsOrg = !!chosen?.orgLabel;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!role) return;
    setBusy(true);
    setError(null);
    try {
      await signup({
        email,
        password,
        name,
        role,
        // Inspectors join an existing company rather than creating one, and
        // the API rejects a signup that sends both.
        organizationName: needsOrg ? organizationName : undefined,
      });
      navigate('/jobs', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-head">
          <div className="brand">
            <span className="brand-mark">IO</span>
            InspectorOne
          </div>
          <p className="muted small">Create your account</p>
        </div>

        <form className="card card-pad" onSubmit={submit}>
          <ErrorNotice error={error} />

          <div className="field">
            <span className="label">What are you signing up as?</span>
            <div className="segment">
              {ROLES.map((r) => (
                <label
                  key={r.value}
                  className={`segment-opt${role === r.value ? ' selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="role"
                    checked={role === r.value}
                    onChange={() => setRole(r.value)}
                  />
                  <span>
                    <span className="segment-title">{r.title}</span>
                    <span className="segment-desc">{r.desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {role && (
            <>
              {needsOrg && (
                <label className="field">
                  <span className="label">{chosen?.orgLabel}</span>
                  <input
                    className="input"
                    required
                    value={organizationName}
                    onChange={(e) => setOrganizationName(e.target.value)}
                  />
                  <span className="hint">{chosen?.orgHint}</span>
                </label>
              )}

              <label className="field">
                <span className="label">Your name</span>
                <input
                  className="input"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>

              <label className="field">
                <span className="label">Email</span>
                <input
                  className="input"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>

              <div className="field">
                <span className="label">Password</span>
                <PasswordInput
                  value={password}
                  onChange={setPassword}
                  autoComplete="new-password"
                  minLength={10}
                  required
                />
                <span className="hint">
                  At least 10 characters. Length matters more than symbols.
                </span>
              </div>

              <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                {busy && <span className="spin" />}
                Create account
              </button>
            </>
          )}
        </form>

        <div className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
