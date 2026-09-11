import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import {
  clearAppErrors,
  getAppErrors,
  subscribeAppErrors,
  type AppErrorRecord,
} from '../utils/error-center';

function detailsText(error: AppErrorRecord): string {
  const context = {
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.sessionId === undefined ? {} : { sessionId: error.sessionId }),
    ...(error.agentId === undefined ? {} : { agentId: error.agentId }),
    ...(error.turnId === undefined ? {} : { turnId: error.turnId }),
    ...(error.toolCallId === undefined ? {} : { toolCallId: error.toolCallId }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return String(error.details);
  }
}

export function ErrorCenter() {
  const { tr } = useI18n();
  const [errors, setErrors] = useState<readonly AppErrorRecord[]>(getAppErrors);
  useEffect(() => subscribeAppErrors(setErrors), []);
  if (errors.length === 0) return null;
  return (
    <aside className="app-error-center" aria-label={tr('Errors', '错误中心')}>
      <div className="app-error-center-head">
        <strong>{tr('Errors', '错误')}</strong>
        <span>{errors.length}</span>
        <button type="button" onClick={clearAppErrors} aria-label={tr('Clear errors', '清除错误')} title={tr('Clear errors', '清除错误')}>×</button>
      </div>
      {errors.map((error) => (
        <div className="app-error-center-item" role="alert" key={error.id}>
          <div className="app-error-center-meta">
            <span>{error.source}</span>
            {error.httpStatus !== undefined && <span>HTTP {error.httpStatus}</span>}
            {error.code !== undefined && <span>{error.code}</span>}
            {error.count > 1 && <span>×{error.count}</span>}
          </div>
          <div className="app-error-center-message">{error.message}</div>
          {error.operation && <small>{error.operation}</small>}
          <details>
            <summary>{tr('Details', '详细信息')}</summary>
            <pre>{detailsText(error)}</pre>
          </details>
        </div>
      ))}
    </aside>
  );
}
