import {
  clientAdminOrgIds,
  companyStaffOrgIds,
  isUnaffiliated,
} from '@inspectorone/shared';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.js';

/**
 * One app, three perspectives.
 *
 * Navigation is derived from the caller's memberships rather than from a single
 * "account type", because one person can genuinely be an inspector at one firm
 * and a client contact at another. Hiding a link is only a convenience - the
 * API enforces every one of these boundaries independently.
 */
export default function Shell() {
  const { principal, logout } = useAuth();
  const navigate = useNavigate();
  if (!principal) return null;

  const isCompanyStaff = companyStaffOrgIds(principal).length > 0;
  const canManageAnyTeam =
    isCompanyStaff || clientAdminOrgIds(principal).length > 0;
  const unaffiliated = isUnaffiliated(principal);

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/jobs" className="brand">
          <span className="brand-mark">IO</span>
          <span className="hide-sm">InspectorOne</span>
        </NavLink>

        {!unaffiliated && (
          <nav className="nav">
            <NavLink to="/jobs">Jobs</NavLink>
            <NavLink to="/gallery">Photos</NavLink>
            {isCompanyStaff && <NavLink to="/sites">Sites</NavLink>}
            {isCompanyStaff && <NavLink to="/clients">Clients</NavLink>}
            {canManageAnyTeam && <NavLink to="/team">Team</NavLink>}
          </nav>
        )}

        <div className="topbar-right">
          <NavLink to="/account" className="btn btn-ghost btn-sm">
            <span className="hide-sm">{principal.name}</span>
            <span className="pill mono">{principal.accountId}</span>
          </NavLink>
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="main">
        {unaffiliated && (
          <div className="notice notice-info">
            <strong>Your account isn't part of an organization yet.</strong>
            <div className="mt small">
              Give your account ID{' '}
              <code className="pill mono">{principal.accountId}</code> to the
              inspecting company you work for. Once they add you, the jobs
              assigned to you will appear here.
            </div>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
