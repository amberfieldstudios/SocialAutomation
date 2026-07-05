import { useEffect, useState } from 'react';
import { api, type DeadLetterJobRecord, type PublishJobRecord, type ScheduleRecord } from '../api/client';
import { Badge } from '../components/Badge';

export function QueueView() {
  const [jobs, setJobs] = useState<PublishJobRecord[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetterJobRecord[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const [j, d, s] = await Promise.all([api.listJobs(), api.listDeadLetters(), api.listSchedules()]);
      setJobs(j.jobs);
      setDeadLetters(d.jobs);
      setSchedules(s.schedules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const upcoming = jobs.filter((j) => j.status === 'pending');
  const inFlight = jobs.filter((j) => j.status === 'claimed' || j.status === 'running');
  const failed = jobs.filter((j) => j.status === 'failed');

  return (
    <section aria-labelledby="queue-heading">
      <h2 id="queue-heading">Queue &amp; schedule</h2>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <button type="button" className="btn secondary" onClick={() => void refresh()}>
        Refresh
      </button>

      <JobTable title="Upcoming (pending)" jobs={upcoming} />
      <JobTable title="In-flight (claimed / running)" jobs={inFlight} />
      <JobTable title="Failed (awaiting retry)" jobs={failed} />

      <h3>Dead-lettered</h3>
      {deadLetters.length === 0 ? (
        <p className="empty-state">No dead-lettered jobs.</p>
      ) : (
        <table>
          <caption className="sr-only">Dead-lettered jobs</caption>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Operation</th>
              <th scope="col">Attempts</th>
              <th scope="col">Error</th>
              <th scope="col">Failed at</th>
            </tr>
          </thead>
          <tbody>
            {deadLetters.map((dl) => (
              <tr key={dl.id}>
                <td>{dl.publishJobId}</td>
                <td>{dl.operation}</td>
                <td>{dl.attempts}</td>
                <td>{dl.errorMessage ?? '—'}</td>
                <td>{new Date(dl.failedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Schedules</h3>
      {schedules.length === 0 ? (
        <p className="empty-state">No schedules created yet.</p>
      ) : (
        <table>
          <caption className="sr-only">Publish schedules</caption>
          <thead>
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">Next run</th>
              <th scope="col">Timezone</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td>{s.mode}</td>
                <td>{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}</td>
                <td>{s.timezone}</td>
                <td>
                  <Badge status={s.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function JobTable({ title, jobs }: { title: string; jobs: PublishJobRecord[] }) {
  return (
    <>
      <h3>{title}</h3>
      {jobs.length === 0 ? (
        <p className="empty-state">Nothing here.</p>
      ) : (
        <table>
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">Operation</th>
              <th scope="col">Status</th>
              <th scope="col">Attempts</th>
              <th scope="col">Available at</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.id}</td>
                <td>{job.operation}</td>
                <td>
                  <Badge status={job.status} />
                </td>
                <td>
                  {job.attempts} / {job.maxAttempts}
                </td>
                <td>{new Date(job.availableAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
