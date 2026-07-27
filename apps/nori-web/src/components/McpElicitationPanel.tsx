import { useEffect, useMemo, useState } from 'react';

import type {
  McpElicitationField,
  McpElicitationRequest,
  McpElicitationResponse,
  McpElicitationValue,
} from '../api/client';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { MarkdownView } from './MarkdownView';

interface McpElicitationPanelProps {
  requests: McpElicitationRequest[];
  onResolve: (
    elicitationId: string,
    response: McpElicitationResponse,
  ) => void | Promise<void>;
}

type DraftValue = string | boolean | string[];

export function McpElicitationPanel({
  requests,
  onResolve,
}: McpElicitationPanelProps) {
  const { tr } = useI18n();
  const request = requests[0];
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(request?.mode === 'form' ? initialDraft(request) : {});
    setError(null);
  }, [request?.elicitation_id]);

  const targetHost = useMemo(() => {
    if (request?.mode !== 'url') return null;
    try {
      return new URL(request.url).host;
    } catch {
      return request.url;
    }
  }, [request]);

  if (request === undefined) return null;

  const resolve = async (response: McpElicitationResponse) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(request.elicitation_id, response);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : tr('Unable to answer the MCP request.', '无法响应 MCP 请求。'),
      );
    } finally {
      setBusy(false);
    }
  };

  const submitForm = () => {
    if (request.mode !== 'form') return;
    const content = buildContent(request, draft);
    if (content === null) {
      setError(tr('Complete all required fields.', '请填写所有必填字段。'));
      return;
    }
    void resolve({ action: 'accept', content });
  };

  const openUrl = () => {
    if (request.mode !== 'url') return;
    window.open(request.url, '_blank', 'noopener,noreferrer');
  };

  const acceptUrl = () => {
    if (request.mode !== 'url') return;
    openUrl();
    void resolve({ action: 'accept' });
  };

  return (
    <aside className="mcp-elicitation-dock" aria-label={tr('MCP request', 'MCP 请求')}>
      <header>
        <span>
          <Icon name={request.mode === 'url' ? 'external' : 'list'} size={15}/>
          <strong>{tr('MCP needs your input', 'MCP 需要你的输入')}</strong>
        </span>
        <small>{request.server_name}</small>
      </header>

      <div className="mcp-elicitation-body">
        <MarkdownView content={request.message}/>

        {request.mode === 'url' ? (
          <div className="mcp-elicitation-url">
            <span>{targetHost}</span>
            <code title={request.url}>{request.url}</code>
            {request.status === 'awaiting_completion' && (
              <div className="mcp-elicitation-waiting">
                <span className="spinner spinner-small"/>
                {tr('Waiting for the MCP server to finish', '正在等待 MCP 服务器完成')}
              </div>
            )}
          </div>
        ) : (
          <div className="mcp-elicitation-fields">
            {Object.entries(request.requested_schema.properties).map(([name, field]) => (
              <McpField
                key={name}
                name={name}
                field={field}
                required={request.requested_schema.required?.includes(name) === true}
                value={draft[name] ?? defaultDraftValue(field)}
                disabled={busy}
                onChange={(value) => setDraft((previous) => ({ ...previous, [name]: value }))}
              />
            ))}
          </div>
        )}
      </div>

      {error !== null && <div className="mcp-elicitation-error">{error}</div>}
      <footer>
        {requests.length > 1 && (
          <span>{tr(`${requests.length} requests`, `${requests.length} 个请求`)}</span>
        )}
        {request.status === 'awaiting_completion' ? (
          <button type="button" className="mcp-elicitation-secondary" onClick={openUrl}>
            <Icon name="external" size={13}/>
            {tr('Open again', '再次打开')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="mcp-elicitation-secondary"
              onClick={() => void resolve({ action: 'cancel' })}
              disabled={busy}
            >
              {tr('Cancel', '取消')}
            </button>
            <button
              type="button"
              className="mcp-elicitation-secondary"
              onClick={() => void resolve({ action: 'decline' })}
              disabled={busy}
            >
              {tr('Decline', '拒绝')}
            </button>
            <button
              type="button"
              className="mcp-elicitation-primary"
              onClick={request.mode === 'url' ? acceptUrl : submitForm}
              disabled={busy}
            >
              {request.mode === 'url' && <Icon name="external" size={13}/>} 
              {busy
                ? tr('Submitting...', '正在提交...')
                : request.mode === 'url'
                  ? tr('Open and continue', '打开并继续')
                  : tr('Submit', '提交')}
            </button>
          </>
        )}
      </footer>
    </aside>
  );
}

function McpField({
  name,
  field,
  required,
  value,
  disabled,
  onChange,
}: {
  name: string;
  field: McpElicitationField;
  required: boolean;
  value: DraftValue;
  disabled: boolean;
  onChange: (value: DraftValue) => void;
}) {
  const options = enumOptions(field);
  const label = field.title ?? name;

  if (field.type === 'boolean') {
    return (
      <label className="mcp-elicitation-boolean">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span><strong>{label}{required ? ' *' : ''}</strong>{field.description && <small>{field.description}</small>}</span>
      </label>
    );
  }

  if (field.type === 'array') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="mcp-elicitation-multiselect" disabled={disabled}>
        <legend>{label}{required ? ' *' : ''}</legend>
        {field.description && <small>{field.description}</small>}
        <div>{options.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() => onChange(
                selected.includes(option.value)
                  ? selected.filter((item) => item !== option.value)
                  : [...selected, option.value],
              )}
            />
            <span>{option.label}</span>
          </label>
        ))}</div>
      </fieldset>
    );
  }

  return (
    <label className="mcp-elicitation-field">
      <span><strong>{label}{required ? ' *' : ''}</strong>{field.description && <small>{field.description}</small>}</span>
      {options.length > 0 ? (
        <select
          value={typeof value === 'string' ? value : ''}
          required={required}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="" disabled={required}>Select</option>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : (
        <input
          type={inputType(field)}
          value={typeof value === 'string' ? value : ''}
          required={required}
          disabled={disabled}
          min={field.minimum}
          max={field.maximum}
          minLength={field.minLength}
          maxLength={field.maxLength}
          step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function initialDraft(request: Extract<McpElicitationRequest, { mode: 'form' }>) {
  return Object.fromEntries(
    Object.entries(request.requested_schema.properties).map(([name, field]) => [
      name,
      defaultDraftValue(field),
    ]),
  );
}

function defaultDraftValue(field: McpElicitationField): DraftValue {
  if (field.type === 'boolean') return field.default === true;
  if (field.type === 'array') return Array.isArray(field.default) ? field.default : [];
  return typeof field.default === 'string' || typeof field.default === 'number'
    ? String(field.default)
    : '';
}

function enumOptions(field: McpElicitationField): Array<{ value: string; label: string }> {
  if (field.oneOf !== undefined) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  if (field.items?.anyOf !== undefined) {
    return field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  }
  const values = field.type === 'array' ? field.items?.enum : field.enum;
  return (values ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index] ?? value,
  }));
}

function inputType(field: McpElicitationField) {
  if (field.type === 'number' || field.type === 'integer') return 'number';
  if (field.format === 'email') return 'email';
  if (field.format === 'uri') return 'url';
  if (field.format === 'date') return 'date';
  if (field.format === 'date-time') return 'datetime-local';
  return 'text';
}

function buildContent(
  request: Extract<McpElicitationRequest, { mode: 'form' }>,
  draft: Record<string, DraftValue>,
): Record<string, McpElicitationValue> | null {
  const required = new Set(request.requested_schema.required ?? []);
  const result: Record<string, McpElicitationValue> = {};
  for (const [name, field] of Object.entries(request.requested_schema.properties)) {
    const value = draft[name] ?? defaultDraftValue(field);
    if (field.type === 'boolean') {
      result[name] = value === true;
      continue;
    }
    if (field.type === 'array') {
      const values = Array.isArray(value) ? value : [];
      if (required.has(name) && values.length === 0) return null;
      if (values.length > 0 || required.has(name)) result[name] = values;
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (required.has(name) && text === '') return null;
    if (text === '') continue;
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(text);
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) {
        return null;
      }
      result[name] = number;
    } else if (field.format === 'date-time') {
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return null;
      result[name] = date.toISOString();
    } else {
      result[name] = text;
    }
  }
  return result;
}
