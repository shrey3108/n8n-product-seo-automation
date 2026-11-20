import React, { useEffect, useState } from 'react';
import { decideAccessRequest, fetchAccessAuditLogs, fetchAccessRequests } from '../services/api';

export default function AccessRequestsAuditPage() {
  const [requests, setRequests] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const params = new URLSearchParams(window.location.search);
  const actorId = params.get('sellerId') || '';

  const loadData = async () => {
    if (!actorId) {
      setMessage('Actor ID missing. Open this page from dashboard context.');
      return;
    }

    setLoading(true);
    setMessage('');
    try {
      const [requestData, auditData] = await Promise.all([
        fetchAccessRequests({ actorId, status: 'pending' }),
        fetchAccessAuditLogs({ actorId })
      ]);
      setRequests(requestData.requests || []);
      setLogs(auditData.logs || []);
    } catch (err) {
      setMessage(err.response?.data?.error || err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDecision = async (requestId, decision) => {
    try {
      setLoading(true);
      await decideAccessRequest({ requestId, decision, note: '', actorId });
      await loadData();
      setMessage(`Request ${decision}d successfully.`);
    } catch (err) {
      setMessage(err.response?.data?.error || err.message || 'Decision failed');
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h2 className="text-lg font-bold text-blue-900">Access Requests + GS Audit</h2>
        <p className="text-sm text-blue-800 mt-1">
          Admin and SuperAdmin can approve seller access requests and review GS mapping/action logs in one place.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="font-semibold text-gray-900 mb-2">Pending Access Requests</h3>
          {loading ? (
            <p className="text-sm text-gray-500">Loading requests...</p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-gray-500">No pending requests.</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-auto">
              {requests.map((req) => (
                <div key={req.requestId} className="border border-gray-200 rounded p-2 text-sm">
                  <div className="font-semibold">{req.requestId}</div>
                  <div className="font-mono text-xs">Entered: {req.enteredGsCode}</div>
                  <div className="font-mono text-xs">Resolved: {req.resolvedCommunetCode}</div>
                  <div className="text-xs">Seller: {req.sellerId}</div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => onDecision(req.requestId, 'approve')}
                      className="bg-emerald-700 text-white px-2 py-1 rounded text-xs"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => onDecision(req.requestId, 'reject')}
                      className="bg-red-700 text-white px-2 py-1 rounded text-xs"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="font-semibold text-gray-900 mb-2">GS Audit Logs</h3>
          {loading ? (
            <p className="text-sm text-gray-500">Loading logs...</p>
          ) : logs.length === 0 ? (
            <p className="text-sm text-gray-500">No audit logs found.</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-auto">
              {logs.map((log) => (
                <div key={log.logId} className="border border-gray-200 rounded p-2 text-xs">
                  <div className="font-semibold">{log.logId}</div>
                  <div>Action: {log.actionType}</div>
                  <div>Table: {log.tableName}</div>
                  <div>User: {log.email}</div>
                  <div>Time: {new Date(log.performedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {message && (
        <div className="bg-gray-100 border border-gray-200 rounded-lg p-3 text-sm text-gray-700">
          {message}
        </div>
      )}

      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
        Admin approvals grant permanent seller access without transferring admin ownership.
      </div>
    </div>
  );
}
