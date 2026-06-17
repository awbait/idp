import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { Card, ErrorBox, Spinner } from "../components/ui";
import { HealthBadge } from "../components/StatusBadge";

export function ApplicationsPage() {
  const { data, error, loading } = useAsync(() => api.listApplications(), []);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const apps = data ?? [];

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">ArgoCD Applications</h1>
      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Team</th>
              <th className="px-4 py-2">Cluster</th>
              <th className="px-4 py-2">Sync</th>
              <th className="px-4 py-2">Health</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((a) => (
              <tr key={a.name} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                <td className="px-4 py-2 font-medium text-gray-800">{a.name}</td>
                <td className="px-4 py-2 text-gray-600">{a.labels?.["idp.team"] ?? "-"}</td>
                <td className="px-4 py-2 text-gray-600">{a.cluster}</td>
                <td className="px-4 py-2 text-gray-600">{a.sync_status}</td>
                <td className="px-4 py-2">
                  <HealthBadge health={a.health_status} />
                </td>
              </tr>
            ))}
            {apps.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                  No applications visible to your teams.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
