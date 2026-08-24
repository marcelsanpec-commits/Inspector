import { companyStaffOrgIds, JOB_STATUSES } from '@inspectorone/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Chevron,
  EmptyState,
  ErrorNotice,
  formatDate,
  Skeletons,
  StatusBadge,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

interface JobRow {
  id: string;
  jobNumber: string;
  title: string;
  status: string;
  clientAccess: string;
  scheduledFor: string | null;
  siteName: string;
  siteCity: string | null;
  clientName: string;
}

export default function Jobs() {
  const { principal } = useAuth();
  const [status, setStatus] = useState('');
  const isCompanyStaff = companyStaffOrgIds(principal!).length > 0;

  const jobs = useQuery({
    queryKey: ['jobs', status],
    queryFn: () =>
      api<{ jobs: JobRow[] }>(`/api/jobs${status ? `?status=${status}` : ''}`),
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <div className="page-sub">
            {isCompanyStaff
              ? 'Every job at your company'
              : 'Jobs assigned to you'}
          </div>
        </div>
        <div className="spacer" />
        <div className="inline">
          <select
            className="select"
            style={{ width: 'auto' }}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {isCompanyStaff && (
            <Link className="btn btn-primary" to="/jobs/new">
              New job
            </Link>
          )}
        </div>
      </div>

      <ErrorNotice error={jobs.error} />
      {jobs.isLoading && <Skeletons />}

      {jobs.data &&
        (jobs.data.jobs.length === 0 ? (
          <div className="card">
            <EmptyState
              title={status ? 'No jobs with that status' : 'No jobs yet'}
              action={
                isCompanyStaff && !status ? (
                  <Link className="btn btn-primary" to="/jobs/new">
                    Create the first job
                  </Link>
                ) : undefined
              }
            >
              {isCompanyStaff
                ? 'Jobs you create will appear here.'
                : 'When your company assigns you a job, it will show up here.'}
            </EmptyState>
          </div>
        ) : (
          <div className="card list">
            {jobs.data.jobs.map((job) => (
              <Link key={job.id} className="row" to={`/jobs/${job.id}`}>
                <div className="row-main">
                  <div className="row-title">{job.title}</div>
                  <div className="row-meta">
                    <span className="mono">{job.jobNumber}</span> · {job.clientName} ·{' '}
                    {job.siteName}
                    {job.siteCity ? `, ${job.siteCity}` : ''}
                    {job.scheduledFor ? ` · ${formatDate(job.scheduledFor)}` : ''}
                  </div>
                </div>
                <div className="row-side">
                  {job.clientAccess === 'restricted' && (
                    <span className="badge badge-restricted hide-sm">restricted</span>
                  )}
                  <StatusBadge status={job.status} />
                  <Chevron />
                </div>
              </Link>
            ))}
          </div>
        ))}
    </>
  );
}
