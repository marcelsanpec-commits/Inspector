import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import Shell from './components/Shell.js';
import { useAuth } from './lib/auth.js';
import AcceptInvite from './routes/AcceptInvite.js';
import Account from './routes/Account.js';
import Clients from './routes/Clients.js';
import Gallery from './routes/Gallery.js';
import Inspection from './routes/Inspection.js';
import JobDetail from './routes/JobDetail.js';
import JobNew from './routes/JobNew.js';
import Jobs from './routes/Jobs.js';
import Login from './routes/Login.js';
import NewStructure from './routes/NewStructure.js';
import ObjectDetail from './routes/ObjectDetail.js';
import Signup from './routes/Signup.js';
import Sites from './routes/Sites.js';
import Structure from './routes/Structure.js';
import Team from './routes/Team.js';

/** The old capture screen's address, kept working for anyone who saved it. */
function CaptureRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/jobs/${id}/inspect`} replace />;
}

function FullPageSpinner() {
  return (
    <div className="auth-wrap">
      <div className="inline muted">
        <span className="spin" />
        Loading
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const { principal, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageSpinner />;
  if (!principal) {
    // Remember where they were headed so login can send them back.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

function RedirectIfSignedIn({ children }: { children: JSX.Element }) {
  const { principal, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (principal) return <Navigate to="/jobs" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfSignedIn>
            <Login />
          </RedirectIfSignedIn>
        }
      />
      <Route
        path="/signup"
        element={
          <RedirectIfSignedIn>
            <Signup />
          </RedirectIfSignedIn>
        }
      />
      {/* Reachable while signed out - the whole point is joining an org. */}
      <Route path="/accept-invite" element={<AcceptInvite />} />

      <Route
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/jobs" replace />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/new" element={<JobNew />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/jobs/:id/inspect" element={<Inspection />} />
        <Route path="/jobs/:id/inspect/new" element={<NewStructure />} />
        <Route path="/jobs/:id/inspect/:structureId" element={<Structure />} />
        <Route path="/jobs/:id/capture" element={<CaptureRedirect />} />
        <Route path="/objects/:objectId" element={<ObjectDetail />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/sites" element={<Sites />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/team" element={<Team />} />
        <Route path="/account" element={<Account />} />
      </Route>

      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
